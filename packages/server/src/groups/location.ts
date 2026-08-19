import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Effect, Layer, Schema } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import path from "node:path"
import { ForbiddenError } from "../errors"

export const LocationQuery = Schema.Struct({
  location: Schema.optional(
    Schema.Struct({
      directory: Schema.optional(Schema.String),
      workspace: Schema.optional(Schema.String),
    }),
  ),
}).annotate({ identifier: "LocationQuery" })

export const locationQueryOpenApi = OpenApi.annotations({
  transform: (operation) => {
    const parameters = operation.parameters
    if (!Array.isArray(parameters)) return operation
    return {
      ...operation,
      parameters: parameters.map((parameter) =>
        parameter?.name === "location" && parameter?.in === "query"
          ? { ...parameter, style: "deepObject", explode: true }
          : parameter,
      ),
    }
  },
})

export function response<A, E, R>(data: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const location = yield* Location.Service
    return {
      location: new Location.Info({
        directory: location.directory,
        workspaceID: location.workspaceID,
        project: location.project,
      }),
      data: yield* data,
    }
  })
}

export type LocationServices = Layer.Success<ReturnType<typeof LocationServiceMap.get>>

export class LocationMiddleware extends HttpApiMiddleware.Service<
  LocationMiddleware,
  {
    provides: LocationServices
  }
>()("@opencode/HttpApiLocation", {
  error: [ForbiddenError],
}) {}

export const LocationGroup = HttpApiGroup.make("server.location")
  .add(
    HttpApiEndpoint.get("location.get", "/api/location", {
      query: LocationQuery,
      success: Location.Info,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.location.get",
          summary: "Get location",
          description: "Resolve the requested location or the server default location.",
        }),
      ),
  )
  .middleware(LocationMiddleware)

/** Cached serve root directory. Resolved once from the env var set at startup,
 *  then locked so later env mutations cannot weaken the guard. */
let cachedServeDirectory: string | undefined

/** @internal Exported for test resets only. */
export function resetServeDirectory() {
  cachedServeDirectory = undefined
}

function getServeDirectory() {
  if (cachedServeDirectory === undefined) {
    cachedServeDirectory = path.resolve(process.env.DEVECO_SERVE_CWD || process.env.PWD || "")
  }
  return cachedServeDirectory
}

/** Resolve and validate that the requested directory is within the serve root. */
function allowedDirectory(requested: string | undefined): Effect.Effect<string, ForbiddenError> {
  const serveDirectory = getServeDirectory()
  if (!requested) return Effect.succeed(serveDirectory)
  const resolved = path.resolve(requested)
  if (resolved === serveDirectory || resolved.startsWith(serveDirectory + path.sep)) {
    return Effect.succeed(resolved)
  }
  console.error(`[ForbiddenError] location[directory] rejected: requested=${requested}, serveDirectory=${serveDirectory}`)
  return Effect.fail(
    new ForbiddenError({
      message: `location[directory] must be within the serve directory: ${serveDirectory}`,
    }),
  )
}

function ref(request: HttpServerRequest.HttpServerRequest): Effect.Effect<Location.Ref, ForbiddenError> {
  const query = new URL(request.url, "http://localhost").searchParams
  const workspaceID = query.get("location[workspace]") || request.headers["x-deveco-workspace"]
  const requested = query.get("location[directory]") || (request.headers["x-deveco-directory"] ? decode(request.headers["x-deveco-directory"]) : undefined)
  return Effect.map(allowedDirectory(requested), (directory) =>
    Location.Ref.make({
      directory: AbsolutePath.make(directory),
      workspaceID: workspaceID ? WorkspaceV2.ID.make(workspaceID) : undefined,
    }),
  )
}

function decode(input: string) {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

export const layer = Layer.effect(
  LocationMiddleware,
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap
    return LocationMiddleware.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const locationRef = yield* ref(request)
        return yield* effect.pipe(Effect.provide(locations.get(locationRef)))
      }),
    )
  }),
)
