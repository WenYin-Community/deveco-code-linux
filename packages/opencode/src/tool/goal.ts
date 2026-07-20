import { Effect, Schema } from "effect"
import { SessionGoal } from "@/session/goal"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  status: Schema.Literals(["complete", "paused"]).annotate({
    description: "complete finishes an achieved goal; paused stops after a model-side failure.",
  }),
  reason: Schema.optional(Schema.String).annotate({
    description: "Concise completion evidence or the model-side failure that requires pausing.",
  }),
})

type Metadata = {
  goal: SessionGoal.Info | null
}

export const UpdateGoalTool = Tool.define<typeof Parameters, Metadata, SessionGoal.Service>(
  "update_goal",
  Effect.gen(function* () {
    const goals = yield* SessionGoal.Service

    return {
      description:
        'Update the active goal status. Use "complete" only when the full objective is achieved and verified. Use "paused" only when a model-side failure prevents safe continuation. Goal creation, replacement, resume, stop, and clear are controlled exclusively by the user through /goal commands.',
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const current = yield* goals.get(ctx.sessionID)
          if (!current) {
            return {
              title: "No active goal",
              output: "No goal exists for this session.",
              metadata: { goal: null },
            }
          }
          if (!(yield* goals.canUpdateFrom(ctx.sessionID, ctx.messageID))) {
            return {
              title: "Goal changed",
              output: "The goal was replaced after this turn began. Continue from the latest injected objective.",
              metadata: { goal: current },
            }
          }
          const goal =
            params.status === "complete"
              ? yield* goals.complete(ctx.sessionID, params.reason)
              : yield* goals.pause(ctx.sessionID, params.reason)
          return {
            title: params.status === "complete" ? "Goal complete" : "Goal paused",
            output: JSON.stringify({ goal }, null, 2),
            metadata: { goal },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
