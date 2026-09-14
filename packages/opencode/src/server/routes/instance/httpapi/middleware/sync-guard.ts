import { RuntimeFlags } from "@/effect/runtime-flags"
import { Effect, Layer } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiError, HttpApiMiddleware } from "effect/unstable/httpapi"

// When experimental workspaces are off, /sync/replay and /sync/steal are not
// reachable: no syncing workspaces exist, so the endpoints serve only as
// attack. Return 404 before payload schema validation so probing requests
// cannot confirm the routes exist. When the flag is on (the default), the
// handlers additionally require a workspace-bound SyncTicket plus (for steal)
// an ownership check.
const GUARDED_PATHS = new Set(["/sync/replay", "/sync/steal"])

export class SyncGuardMiddleware extends HttpApiMiddleware.Service<SyncGuardMiddleware>()(
  "@opencode/ExperimentalHttpApiSyncGuard",
  { error: HttpApiError.NotFoundNoContent },
) {}

export const syncGuardLayer = Layer.effect(
  SyncGuardMiddleware,
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    return SyncGuardMiddleware.of((effect) =>
      Effect.gen(function* () {
        if (flags.experimentalWorkspaces) return yield* effect
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        if (!GUARDED_PATHS.has(url.pathname)) return yield* effect
        return yield* new HttpApiError.NotFound({})
      }),
    )
  }),
)
