import type { Hooks } from "@opencode-ai/plugin"
import path from "node:path"
import { clearSessionCwd, setSessionCwd } from "@/tool/lib/session-cwd"

export async function SessionCwdPlugin(): Promise<Hooks> {
  return {
    "tool.execute.after": async (input, output) => {
      // The plugin has already checked permissions and resolved the target.
      // Use its successful result, never the unvalidated tool arguments.
      const target: unknown =
        input.tool === "switch_cwd" && input.source === "custom"
          ? output.metadata?.project_path
          : input.tool === "bash"
            ? output.metadata?.sessionCwd
            : undefined
      if (typeof target !== "string" || !path.isAbsolute(target)) return
      setSessionCwd(input.sessionID, target)
    },
    event: async ({ event }) => {
      if (event.type === "session.deleted") clearSessionCwd(event.properties.info.id)
    },
  }
}
