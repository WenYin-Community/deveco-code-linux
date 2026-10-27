import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { ensureHdcGuardShellEnv } from "@/hdc/shim-env"

// Arms the HDC guard for every controlled shell. Failures are
// swallowed on purpose: a shell whose guard cannot arm must keep
// working, with `hdc` failing closed at the shim instead (CON-05).
export async function HdcGuardEnvPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    "shell.env": async (input, output) => {
      const extra = await ensureHdcGuardShellEnv(input.sessionID, input.callID, output.env.PATH, input.directory).catch(() => undefined)
      if (!extra) return
      Object.assign(output.env, extra)
    },
  }
}
