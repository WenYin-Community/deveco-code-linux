import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless deveco server",
  // Server loads instances per-request via x-deveco-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    const opts = yield* resolveNetworkOptions(args)
    if (!Flag.DEVECO_SERVER_PASSWORD) {
      const isLocalhost = opts.hostname === "127.0.0.1" || opts.hostname === "localhost" || opts.hostname === "::1"
      if (!isLocalhost) {
        yield* Effect.die(
          new Error(
            "Server is binding to a non-localhost address without DEVECO_SERVER_PASSWORD. Set DEVECO_SERVER_PASSWORD or bind to 127.0.0.1.",
          ),
        )
      }
      console.log("Warning: DEVECO_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`deveco server listening on http://${server.hostname}:${server.port}`)

    yield* Effect.never
  }),
})
