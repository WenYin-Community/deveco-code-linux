import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { recordClientCommand } from "@/plugin/analytics/client-command"
import { usableProjectDirectory } from "@/plugin/analytics/project-id"
import { InstanceHttpApi } from "../api"
import { ClientCommandPayload } from "../groups/analytics"

export const analyticsHandlers = HttpApiBuilder.group(InstanceHttpApi, "analytics", (handlers) =>
  Effect.gen(function* () {
    // Reporting is best-effort by contract (recordClientCommand never throws), so the endpoint
    // always succeeds and the client never has to retry or expose analytics failures.
    const command = Effect.fn("AnalyticsHttpApi.command")(function* (ctx: {
      query: { directory?: string }
      payload: typeof ClientCommandPayload.Type
    }) {
      yield* Effect.promise(async () => {
        // The body is the client's own project directory; the query parameter is the routing
        // fallback. Anything that is not an existing absolute directory is discarded here so it
        // can never mint a project id.
        const directory =
          (await usableProjectDirectory(ctx.payload.directory)) ?? (await usableProjectDirectory(ctx.query.directory))
        await recordClientCommand({
          name: ctx.payload.name,
          sessionID: ctx.payload.sessionID,
          directory,
        })
      })
      return true
    })

    return handlers.handle("command", command)
  }),
)
