import type { WakeEvent } from "./types.js";

export const RUNNER_VERSION = "0.2.0";

export class HttpError extends Error {
  constructor(
    public status: number,
    public body: string,
    public retryAfterMs?: number,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`);
  }
}

export interface WaitResult {
  events: WakeEvent[];
  cursor: string;
  paused?: boolean;
  max_timeout?: number;
}

export interface TaskRow {
  id: string;
  title?: string | null;
  status?: string | null;
  updated_at?: string | null;
  assignee_worker_id?: string | null;
}

/** Thin client over the Tango worker REST API (tng_ bearer). */
export class TangoClient {
  constructor(
    private baseUrl: string,
    private key: string,
    private meta: { host: string; harness: string },
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.key}`,
      "Content-Type": "application/json",
      "X-Tango-Runner": `tango-runner/${RUNNER_VERSION}`,
      "X-Tango-Runner-Host": this.meta.host,
      "X-Tango-Runner-Harness": this.meta.harness,
    };
  }

  private async req<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    // redirect: "manual" — *.lovable.app hosts 302 and drop Authorization on redirect.
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      redirect: "manual",
    });
    const text = await res.text();
    if (res.status >= 300 && res.status < 400) {
      throw new HttpError(res.status, `redirected to ${res.headers.get("location")}; use the canonical Tango URL`);
    }
    if (!res.ok) {
      const ra = Number(res.headers.get("retry-after"));
      throw new HttpError(res.status, text, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Long-poll for wake events. Throws HttpError(404) when the server predates /wait. */
  wait(cursor: string | null, timeoutSec: number, signal?: AbortSignal): Promise<WaitResult> {
    const q = new URLSearchParams({ timeout: String(timeoutSec) });
    if (cursor) q.set("cursor", cursor);
    return this.req<WaitResult>("GET", `/api/public/workers/wait?${q}`, undefined, signal);
  }

  ack(cursor: string): Promise<{ ok: boolean }> {
    return this.req("POST", "/api/public/workers/wait/ack", { cursor });
  }

  heartbeat(): Promise<{ ok: boolean; worker_id?: string; unread_messages?: number; reachability_mode?: string }> {
    return this.req("POST", "/api/public/workers/heartbeat", {});
  }

  async listMyTasks(): Promise<TaskRow[]> {
    const r = await this.req<{ tasks?: TaskRow[] }>("GET", "/api/public/workers/list_tasks?mine=1&limit=100");
    return r.tasks ?? [];
  }
}
