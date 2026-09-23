import { cmd } from "./cmd"
import { UI } from "@/cli/ui"
import { errorMessage } from "@opencode-ai/tui/util/error"
import { validateSession } from "../tui/validate-session"
import { ServerAuth } from "@/server/auth"
import { ensureMainlandChinaCliAccess } from "@/cli/deveco-region"

export const AttachCommand = cmd({
  command: "attach <url>",
  describe: "attach to a running deveco server",
  builder: (yargs) =>
    yargs
      .positional("url", {
        type: "string",
        describe: "http://localhost:4096",
        demandOption: true,
      })
      .option("dir", {
        type: "string",
        description: "directory to run in",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("fork", {
        type: "boolean",
        describe: "fork the session when continuing (use with --continue or --session)",
      })
      .option("password", {
        alias: ["p"],
        type: "string",
        describe: "basic auth password (defaults to DEVECO_SERVER_PASSWORD)",
      })
      .option("username", {
        alias: ["u"],
        type: "string",
        describe: "basic auth username (defaults to DEVECO_SERVER_USERNAME or 'deveco')",
      }),
  handler: async (args) => {
    if (!(await ensureMainlandChinaCliAccess())) return

    const { TuiConfig } = await import("@/config/tui")
    if (args.fork && !args.continue && !args.session) {
      UI.error("--fork requires --continue or --session")
      process.exitCode = 1
      return
    }

    const directory = (() => {
      if (!args.dir) return undefined
      try {
        process.chdir(args.dir)
        return process.cwd()
      } catch {
        // If the directory doesn't exist locally (remote attach), pass it through.
        return args.dir
      }
    })()
    const headers = ServerAuth.headers({ password: args.password, username: args.username })
    const config = await TuiConfig.get()

    try {
      await validateSession({
        url: args.url,
        sessionID: args.session,
        directory,
        headers,
      })
    } catch (error) {
      UI.error(errorMessage(error))
      process.exitCode = 1
      return
    }

    const { Effect } = await import("effect")
    const { run } = await import("../tui/layer")
    const { createLegacyTuiPluginHost } = await import("@/plugin/tui/runtime")
    const { registerDevEcoTuiExtensions } = await import("@/cli/deveco-ui/register")
    const { invalidateImprovementConsentCache } = await import("@/plugin/deveco/improvement-consent")
    // T2.7 (review catch I11): bind the improvement-change callback like
    // tui.ts does, adapted to the attach topology. There is no worker thread
    // here and the remote server exposes no setAnalyticsMagpieEnabled HTTP
    // endpoint (a new API was ruled out, design §9.6), so the worker-RPC
    // binding cannot be replicated verbatim. Mirror its cache-invalidation
    // half locally: every consent judgment in this TUI process re-reads the
    // record immediately, while the collecting server process converges via
    // the 30s TTL (ADR-5). The runtime collection switch is deliberately NOT
    // flipped locally — this process hosts no magpie plugin, and driving the
    // local uploader from here could race a same-machine server over the
    // shared pending-event queue.
    registerDevEcoTuiExtensions({
      onToolImprovementEnabledChange: async () => {
        invalidateImprovementConsentCache()
      },
    })
    await Effect.runPromise(
      run({
        url: args.url,
        config,
        pluginHost: createLegacyTuiPluginHost(),
        args: {
          continue: args.continue,
          sessionID: args.session,
          fork: args.fork,
        },
        directory,
        headers,
      }),
    )
  },
})
