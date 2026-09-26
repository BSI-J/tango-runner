// Shapes shared across the runner. WakeEvent mirrors the Tango
// GET /api/public/workers/wait response.

export interface WakeActor {
  kind: "worker" | "user" | "system" | string;
  id: string | null;
  handle: string | null;
  is_self: boolean;
}

export interface WakeEvent {
  id: string;
  type: string;
  created_at: string;
  task_id: string | null;
  thread_id: string | null;
  message_id: string | null;
  actor: WakeActor;
  title: string | null;
  summary: string;
  payload: Record<string, unknown>;
  /** Set by the runner for events it synthesized while polling (no server cursor). */
  synthetic?: boolean;
}

export type Harness = "claude" | "codex" | "command";

export interface AgentConfig {
  /** Local label, used in logs and state keys. */
  name: string;
  /** tng_ worker key, or leave empty and set key_env. */
  key?: string;
  key_env?: string;
  harness: Harness;
  /** Working directory the agent runs in (your repo). */
  cwd: string;
  /** "/mcp" (full Tango) or "/mcp/lite". */
  mcp_path?: string;
  /** Harness "command": shell command to run. Prompt arrives on stdin and in $TANGO_WAKE_PROMPT. */
  command?: string;
  /** Model override passed to the harness CLI. */
  model?: string;
  /** Claude Code --permission-mode. Default "acceptEdits". */
  permission_mode?: string;
  /** Extra tools to allow (Claude Code --allowedTools syntax, e.g. "Bash(npm test:*)"). */
  allowed_tools?: string[];
  /** Only load the Tango MCP server in runs (Claude Code --strict-mcp-config). Default true. */
  strict_mcp?: boolean;
  /** Extra CLI args appended to the harness invocation. */
  extra_args?: string[];
  /** Path to the harness binary if it isn't on PATH. */
  bin?: string;
  /** Concurrent runs for this agent. Default 1. */
  max_concurrent?: number;
  /** Kill a run after this many minutes. Default 30. */
  timeout_minutes?: number;
  /** Only wake for these event types (default: all except ignored ones). */
  events?: string[];
}

export interface RunnerConfig {
  tango_url: string;
  agents: AgentConfig[];
  limits?: {
    /** Per agent. Default 30. */
    max_runs_per_hour?: number;
    /** Follow-up runs for one task/thread triggered only by self-caused events. Default 2. */
    max_self_followups?: number;
  };
  /** Seconds between polls in fallback mode (server has no /wait yet). Default 20. */
  poll_seconds?: number;
}

export interface RunResult {
  ok: boolean;
  exitCode: number | null;
  sessionId?: string;
  timedOut?: boolean;
  summary?: string;
}
