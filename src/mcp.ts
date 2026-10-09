import { RUNNER_VERSION } from "./client.js";

/** Bad command-line input; the CLI exits 2. */
export class UsageError extends Error {}

/** `key=value` pairs (values parsed as JSON when possible) or one JSON object. */
export function parseToolArgs(parts: string[]): Record<string, unknown> {
  if (parts.length === 1 && parts[0].trim().startsWith("{")) {
    try {
      return JSON.parse(parts[0]) as Record<string, unknown>;
    } catch (e) {
      throw new UsageError(`arguments aren't valid JSON: ${(e as Error).message}`);
    }
  }
  const out: Record<string, unknown> = {};
  for (const p of parts) {
    const i = p.indexOf("=");
    if (i < 1) throw new UsageError(`expected key=value, got "${p}"`);
    const raw = p.slice(i + 1);
    let val: unknown = raw;
    try {
      val = JSON.parse(raw);
    } catch {
      /* plain string */
    }
    out[p.slice(0, i)] = val;
  }
  return out;
}

/** A tool ran but reported failure (MCP `isError`). `payload` is Tango's error object. */
export class ToolError extends Error {
  constructor(
    public tool: string,
    public payload: unknown,
  ) {
    super(toolErrorMessage(tool, payload));
  }
}

function toolErrorMessage(tool: string, payload: unknown): string {
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    const msg = p.message ?? p.error ?? p.reason;
    if (typeof msg === "string") return `${tool}: ${msg}${typeof p.hint === "string" ? ` (${p.hint})` : ""}`;
    if (msg && typeof msg === "object") return `${tool}: ${JSON.stringify(msg)}`;
  }
  return `${tool} failed: ${typeof payload === "string" ? payload : JSON.stringify(payload)}`;
}

export interface ToolInfo {
  name: string;
  description?: string;
}

/**
 * Minimal MCP client for Tango's `/mcp` endpoint with a `tng_` worker key.
 * Tango answers worker keys statelessly with plain JSON (no session, no SSE),
 * so each call is one JSON-RPC POST.
 */
export class McpClient {
  private nextId = 1;

  constructor(
    private url: string,
    private key: string,
  ) {}

  private async rpc(method: string, params?: unknown): Promise<unknown> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "X-Tango-Runner": `tango-runner/${RUNNER_VERSION}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, ...(params === undefined ? {} : { params }) }),
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`${this.url} redirected to ${res.headers.get("location")}; set TANGO_URL to the canonical Tango URL`);
    }
    const text = await res.text();
    if (res.status === 401) throw new Error("Tango rejected the worker key (401). It may be revoked; issue a new one.");
    const msg = parseRpc(text);
    if (!msg) throw new Error(`Unexpected response from ${this.url} (HTTP ${res.status})`);
    if (msg.error) throw new Error(`Tango: ${msg.error.message ?? JSON.stringify(msg.error)}`);
    return msg.result;
  }

  async listTools(): Promise<ToolInfo[]> {
    const r = (await this.rpc("tools/list")) as { tools?: ToolInfo[] };
    return r.tools ?? [];
  }

  /** Call a tool and return its structured payload. Throws ToolError when Tango reports failure. */
  async call(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const r = (await this.rpc("tools/call", { name: tool, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
      structuredContent?: unknown;
      isError?: boolean;
    };
    let payload: unknown = r.structuredContent;
    if (payload === undefined) {
      const text = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    if (r.isError) throw new ToolError(tool, payload);
    return payload;
  }
}

type RpcMessage = { result?: unknown; error?: { message?: string } };

/** Plain JSON, or the last `data:` frame of an SSE body (streamable-http servers may answer either way). */
function parseRpc(text: string): RpcMessage | null {
  try {
    return JSON.parse(text) as RpcMessage;
  } catch {
    const frames = text
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    for (const f of frames.reverse()) {
      try {
        return JSON.parse(f) as RpcMessage;
      } catch {
        /* next */
      }
    }
    return null;
  }
}
