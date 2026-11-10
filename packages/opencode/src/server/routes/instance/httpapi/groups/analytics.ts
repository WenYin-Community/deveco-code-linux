import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/analytics"

// Reported by clients (the TUI) for slash commands they execute themselves: those never
// reach SessionPrompt.command, so the server cannot observe them through the command hook.
export const ClientCommandPayload = Schema.Struct({
  // Command name without the leading slash.
  name: Schema.String,
  sessionID: Schema.optional(Schema.String),
  directory: Schema.optional(Schema.String),
}).annotate({ identifier: "AnalyticsClientCommandPayload" })

export const AnalyticsPaths = {
  command: `${root}/command`,
} as const

export const AnalyticsApi = HttpApi.make("analytics")
  .add(
    HttpApiGroup.make("analytics")
      .add(
        HttpApiEndpoint.post("command", AnalyticsPaths.command, {
          query: WorkspaceRoutingQuery,
          payload: ClientCommandPayload,
          success: described(Schema.Boolean, "Command report accepted"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "analytics.command",
            summary: "Report a client-executed slash command",
            description:
              "Record a slash command the client (e.g. the TUI) executed locally. Server-dispatched commands are recorded by the command hook instead.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "analytics",
          description: "Experimental HttpApi analytics routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "DevEco Code experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi routes for selected instance requests.",
    }),
  )
