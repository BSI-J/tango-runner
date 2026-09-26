import { baseEnv, type AdapterInput, type SpawnSpec } from "./spec.js";

/**
 * Any CLI: runs `command` through the shell. The prompt (rules + wake) is piped
 * to stdin and also set as $TANGO_WAKE_PROMPT; raw events are in $TANGO_WAKE_EVENTS.
 */
export function commandSpec(i: AdapterInput): SpawnSpec {
  return {
    cmd: i.agent.command!,
    args: [],
    env: { ...baseEnv(i), TANGO_SYSTEM_RULES: i.systemRules },
    stdin: `${i.systemRules}\n\n${i.prompt}\n`,
    shell: true,
  };
}
