import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { sanitizePath } from "@opencode-ai/core/sanitize-path"
import { DirectoryUnreadableError } from "@opencode-ai/server/errors"
import { Effect, Layer } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { DirectoryMissingError, InvalidRequestError } from "../errors"
import { WorkspaceRouteContext } from "./workspace-routing"

export class InstanceContextMiddleware extends HttpApiMiddleware.Service<
  InstanceContextMiddleware,
  {
    requires: WorkspaceRouteContext
  }
>()("@opencode/ExperimentalHttpApiInstanceContext", {
  // Declaring the errors here instead of encoding a response by hand is what puts them in the
  // OpenAPI contract, so the generated client can type them and the TUI can tell a deleted
  // working directory apart from an ordinary 500.
  error: [DirectoryMissingError, DirectoryUnreadableError, InvalidRequestError],
}) {}

function decode(input: string): string | undefined {
  try {
    return decodeURIComponent(input)
  } catch {
    return undefined
  }
}

function provideInstanceContext<E>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E>,
  store: InstanceStore.Interface,
  fs: FSUtil.Interface,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E | DirectoryMissingError | DirectoryUnreadableError | InvalidRequestError,
  WorkspaceRouteContext
> {
  return Effect.gen(function* () {
    const route = yield* WorkspaceRouteContext
    const directory = decode(route.directory)
    // A malformed escape such as `?directory=%E0` is an invalid request, not a deleted directory.
    // The old fallback kept the raw string and answered 409, which tells the client to move its
    // session to another directory; 400 instead names the query parameter that is wrong.
    if (directory === undefined) {
      yield* Effect.logWarning("requested instance directory cannot be decoded", {
        directory: sanitizePath(route.directory),
      })
      return yield* new InvalidRequestError({
        message: "Invalid directory query parameter",
        kind: "Query",
        field: "directory",
      })
    }
    // Booting an instance calls realPath on its directory, and the location services it later
    // provides do the same, so a deleted directory used to fail as a defect (500) inside whichever
    // handler touched it first. Answer with a typed error before the store loads instead.
    //
    // A directory that exists but cannot be inspected is deliberately not folded into the missing
    // case: the client reacts to "missing" by offering to move the session elsewhere, which must
    // not happen because of a permission problem.
    // The route hands over a directory that is already percent-decoded, so decoding it a second
    // time rewrites a name that looks like an escape: a checkout literally named `a%20b` would be
    // looked up as `a b`. Prefer the undecoded name when that is the one that exists, which keeps
    // such checkouts reachable without trusting the second decode over the filesystem.
    let target = directory
    let state = yield* fs.checkDir(target)
    if (state === "missing" && route.directory !== directory) {
      const undecoded = yield* fs.checkDir(route.directory)
      if (undecoded !== "missing") {
        target = route.directory
        state = undecoded
      }
    }
    if (state === "missing") {
      yield* Effect.logWarning("requested instance directory is missing", { directory: sanitizePath(target) })
      return yield* new DirectoryMissingError({
        directory: target,
        message: `The requested working directory no longer exists: ${target}`,
      })
    }
    if (state === "unreadable") {
      yield* Effect.logWarning("requested instance directory cannot be read", { directory: sanitizePath(target) })
      return yield* new DirectoryUnreadableError({
        directory: target,
        message: `The requested working directory cannot be read: ${target}`,
      })
    }
    const ctx = yield* store.load({ directory: target })
    return yield* effect.pipe(
      Effect.provideService(InstanceRef, ctx),
      Effect.provideService(WorkspaceRef, route.workspaceID),
    )
  })
}

export const instanceContextLayer = Layer.effect(
  InstanceContextMiddleware,
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const fs = yield* FSUtil.Service
    return InstanceContextMiddleware.of((effect) => provideInstanceContext(effect, store, fs))
  }),
).pipe(Layer.provide(FSUtil.defaultLayer))
