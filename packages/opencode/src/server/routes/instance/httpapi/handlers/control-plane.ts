import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { DirectoryUnavailableError } from "@opencode-ai/core/project/copy"
import { SessionV2 } from "@opencode-ai/core/session"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"
import { ApiMoveSessionError, MoveSessionPayload } from "../groups/control-plane"

export const controlPlaneHandlers = HttpApiBuilder.group(RootHttpApi, "controlPlane", (handlers) =>
  Effect.gen(function* () {
    const service = yield* MoveSession.Service

    const moveSession = Effect.fn("ControlPlaneHttpApi.moveSession")(function* (ctx: {
      payload: typeof MoveSessionPayload.Type
    }) {
      yield* service.moveSession(ctx.payload).pipe(
        Effect.mapError(
          (error) =>
            new ApiMoveSessionError({
              name: "MoveSessionError",
              data: { message: message(error) },
            }),
        ),
      )
    })

    return handlers.handle("moveSession", moveSession)
  }),
)

function message(error: MoveSession.Error) {
  if (error instanceof SessionV2.NotFoundError) return `Session not found: ${error.sessionID}`
  if (error instanceof MoveSession.DestinationProjectMismatchError)
    return "Destination directory belongs to another project"
  // The same error now covers both ends of the move (a destination that is missing or is not a
  // directory, and a source that cannot be inspected), so the wording must not claim which one.
  if (error instanceof DirectoryUnavailableError) return `The directory cannot be used: ${error.directory}`
  if (error instanceof MoveSession.ApplyChangesError)
    return `Unable to apply your changes in the destination directory. The files may conflict with existing changes.`
  return error.message
}
