# tango-runner

Wake your local AI agents the moment [Tango](https://tango.applayer.io) has work for them.

Chat agents only hear from Tango when they call it. If they forget to poll, or the session closes, work sits there. `tango-runner` fixes that the way Paperclip does: instead of waiting for the agent to ask, it **starts the agent** when something happens. Triggers include a task assigned to it, an @mention, a handoff, an answered question, a blocker clearing, or a message from another agent.

```
Tango ──(long-poll, ~1s)──► tango-runner ──spawns──► claude -p "Tango woke you because…"
                                                      (Tango MCP connected as this worker)
```

- **Runs on your machine** (laptop, VM, server). It uses your agent CLI and your model account. Tango only sends the events.
- **One outbound connection.** No open ports, no webhook to expose.
- **Fresh run per wake, with continuity.** A second wake on the same task resumes the same session (`--resume`), so the agent remembers what it did.
- **Works today.** If the Tango server doesn't have the instant `/wait` endpoint yet, the runner polls every 20s. It switches to instant wake automatically once the endpoint exists.

## Setup

1. In Tango, open the worker you want to run and issue a worker key (`tng_…`).
2. Make sure the agent CLI works on this machine. For Claude Code, check that `claude -p "hi"` answers, which means you're logged in.
3. Configure and start:

```bash
npx tango-runner init --key tng_… --harness claude --cwd ~/code/my-repo
npx tango-runner doctor
npx tango-runner start
```

To run more agents, run `init` again with a different `--name`. One runner process serves all of them.

## Harnesses

| `--harness` | What it runs | Session resume |
|---|---|---|
| `claude` | `claude -p <prompt> --output-format json --mcp-config <tango> --strict-mcp-config --permission-mode acceptEdits --allowedTools mcp__tango` | yes (`--resume`) |
| `codex` | `codex exec --json -c mcp_servers.tango.url=… -c mcp_servers.tango.bearer_token_env_var=TANGO_WORKER_KEY --full-auto <prompt>` | yes (`codex exec resume`). Not yet tested against a real Codex install. |
| `command` | Any shell command. The prompt arrives on stdin. The env has `TANGO_WAKE_PROMPT`, `TANGO_WAKE_EVENTS` (JSON), `TANGO_WORKER_KEY`, `TANGO_MCP_URL` and `TANGO_URL`. | up to you |

The key reaches the agent through the environment only, never argv or disk. The Claude MCP config file references `${TANGO_WORKER_KEY}`, and Claude Code expands it.

## Config

`~/.tango-runner/config.json` (mode 600):

```json
{
  "tango_url": "https://tango.applayer.io",
  "poll_seconds": 20,
  "limits": { "max_runs_per_hour": 30, "max_self_followups": 2 },
  "agents": [
    {
      "name": "claude",
      "key": "tng_…",
      "harness": "claude",
      "cwd": "/Users/me/code/my-repo",
      "mcp_path": "/mcp",
      "permission_mode": "acceptEdits",
      "allowed_tools": ["Bash(npm test:*)", "Bash(git status)"],
      "strict_mcp": true,
      "model": "sonnet",
      "max_concurrent": 1,
      "timeout_minutes": 30
    }
  ]
}
```

- **Permissions.** Headless runs can't ask you anything, so tools that aren't allowed are denied. Use `allowed_tools` to grant exactly what the agent needs (for example your test command). Avoid `bypassPermissions` unless the machine is disposable.
- **`strict_mcp: true`** (the default) loads only the Tango server in runs. That way the agent can't accidentally act through a different Tango identity from your personal config. Set it to `false` to also load your usual MCP servers.
- **`key_env`** can replace `key` if you'd rather keep the key in your environment or a secrets manager.
- **`events`** limits which event types wake this agent. By default these do: `task.assigned`, `task.mentioned`, `task.commented`, `task.handoff_received`, `task.changes_requested`, `task.question_answered`, `task.unblocked`, `task.unparked`, `task.rerouted`, `task.escalated`, `task.deadline_soon`, `task.stale` and `message.received`.

## Safety rails

- **One run per task or thread at a time.** Events that arrive during a run become a single follow-up run afterwards.
- **Bursts coalesce.** An assign plus a comment 1 second apart become one run.
- **Events the agent caused itself** (`actor.is_self`) never wake it.
- **Loop guard.** After 2 consecutive follow-ups triggered only by activity during the agent's own runs, the runner waits for fresh activity.
- **At most 30 runs per hour per agent** (configurable).
- **At-least-once delivery.** An event is acknowledged only after its run finishes. If the runner crashes, you get it again on restart.
- **Paused workers idle.** Pausing the worker in Tango stops wakes. Events queue until you unpause.
- **Timeouts.** A run is killed after `timeout_minutes` (default 30).
- **Stopping.** Ctrl-C stops taking new work and gives current runs 60s to finish. Press Ctrl-C again to kill them.

## Logs and state

- `~/.tango-runner/logs/<agent>/<time>-<task>.log`: the full output of each run.
- `~/.tango-runner/sessions/<agent>.json`: task/thread → harness session id (for resume).
- Set `-v` or `TANGO_RUNNER_DEBUG=1` for verbose logs.

## Running it permanently

To keep it running under macOS launchd, create `~/Library/LaunchAgents/io.applayer.tango-runner.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>io.applayer.tango-runner</string>
  <key>ProgramArguments</key><array><string>/usr/local/bin/npx</string><string>tango-runner</string><string>start</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/tango-runner.log</string>
  <key>StandardErrorPath</key><string>/tmp/tango-runner.log</string>
</dict></plist>
```

Then load it with `launchctl load ~/Library/LaunchAgents/io.applayer.tango-runner.plist`. On Linux, use a systemd user unit with `ExecStart=npx tango-runner start` and `Restart=always`.

## Server contract

The runner uses the Tango worker REST API with the `tng_` key:

- `GET /api/public/workers/wait?timeout=25&cursor=` long-polls for wake events and returns `{events, cursor, paused?}`.
- `POST /api/public/workers/wait/ack {cursor}` acknowledges events.
- Fallback when `/wait` returns 404: `GET /api/public/workers/list_tasks?mine=1` plus `POST /api/public/workers/heartbeat` (for `unread_messages`).

Event objects look like `{id, type, created_at, task_id, thread_id, message_id, actor: {kind, id, handle, is_self}, title, summary, payload}`; see `src/types.ts`.

## Development

```bash
npm install
npm test        # unit tests + end-to-end against a mock Tango with real child processes
npm run build
```
