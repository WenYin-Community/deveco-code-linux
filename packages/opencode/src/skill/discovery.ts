import nodePath from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient, path } from "@opencode-ai/core/effect/layer-node-platform"
import { NodePath } from "@effect/platform-node"
import { Effect, Layer, Path, Schema, Context, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"

const skillConcurrency = 4
const fileConcurrency = 8
const MAX_SKILL_FILE_BYTES = 50 * 1024 * 1024

function isSafeSegment(value: string) {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  )
}

function isSafeRelativePath(value: string) {
  const segments = value.split("/")
  return (
    value.length > 0 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.includes("?") &&
    !value.includes("#") &&
    !URL.canParse(value) &&
    !nodePath.posix.isAbsolute(value) &&
    !nodePath.win32.isAbsolute(value) &&
    segments.every((segment) => {
      try {
        const decoded = decodeURIComponent(segment)
        return (
          decoded.length > 0 &&
          decoded !== "." &&
          decoded !== ".." &&
          !decoded.includes("/") &&
          !decoded.includes("\\") &&
          !decoded.includes("\0")
        )
      } catch {
        return false
      }
    })
  )
}

class IndexSkill extends Schema.Class<IndexSkill>("IndexSkill")({
  name: Schema.String,
  files: Schema.Array(Schema.String),
}) {}

class Index extends Schema.Class<Index>("Index")({
  skills: Schema.Array(IndexSkill),
}) {}

export interface Interface {
  readonly pull: (url: string) => Effect.Effect<string[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SkillDiscovery") {}

export const layer: Layer.Layer<Service, never, FSUtil.Service | Path.Path | HttpClient.HttpClient> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const path = yield* Path.Path
    const http = HttpClient.filterStatusOk(withTransientReadRetry(yield* HttpClient.HttpClient))
    const cache = path.join(Global.Path.cache, "skills")

    const download = Effect.fn("Discovery.download")(function* (url: string, dest: string) {
      if (yield* fs.exists(dest).pipe(Effect.orDie)) return true

      return yield* HttpClientRequest.get(url).pipe(
        http.execute,
        Effect.flatMap((res) => {
          const contentLength = res.headers["content-length"]
          if (contentLength && Number.parseInt(contentLength, 10) > MAX_SKILL_FILE_BYTES) {
            return Effect.fail(new Error(`Skill file too large: ${url}`))
          }
          return Effect.gen(function* () {
            const chunks: Uint8Array[] = []
            let size = 0
            yield* Stream.runForEach(res.stream, (chunk: Uint8Array) =>
              Effect.gen(function* () {
                size += chunk.byteLength
                if (size > MAX_SKILL_FILE_BYTES) {
                  return yield* Effect.fail(new Error(`Skill file too large: ${url}`))
                }
                chunks.push(chunk)
                return undefined
              }),
            )
            return Buffer.concat(chunks, size)
          })
        }),
        Effect.flatMap((body) => fs.writeWithDirs(dest, new Uint8Array(body))),
        Effect.as(true),
        Effect.catch((err) => Effect.logError("failed to download", { url: url, error: err }).pipe(Effect.as(false))),
      )
    })

    const pull = Effect.fn("Discovery.pull")(function* (url: string) {
      const base = url.endsWith("/") ? url : `${url}/`
      const index = new URL("index.json", base).href
      const host = base.slice(0, -1)

      yield* Effect.logInfo("fetching index", { url: index })

      const data = yield* HttpClientRequest.get(index).pipe(
        HttpClientRequest.acceptJson,
        http.execute,
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Index)),
        Effect.catch((err) =>
          Effect.logError("failed to fetch index", { url: index, error: err }).pipe(Effect.as(null)),
        ),
      )

      if (!data) return []

      const missing = data.skills.filter((skill) => !skill.files.includes("SKILL.md"))
      yield* Effect.forEach(
        missing,
        (skill) => Effect.logWarning("skill entry missing SKILL.md", { url: index, skill: skill.name }),
        { discard: true },
      )
      const list = data.skills.filter((skill) => skill.files.includes("SKILL.md"))

      const dirs = yield* Effect.forEach(
        list,
        (skill) =>
          Effect.gen(function* () {
            if (!isSafeSegment(skill.name)) {
              yield* Effect.logWarning("skill name contains unsafe path segments, skipping", { skill: skill.name })
              return null
            }

            const root = path.join(cache, skill.name)
            if (!FSUtil.contains(cache, root) || root === cache) {
              yield* Effect.logWarning("skill name escapes cache directory, skipping", { skill: skill.name })
              return null
            }

            const skillUrl = new URL(`${encodeURIComponent(skill.name)}/`, host)
            const files = skill.files.map((file) => {
              if (!isSafeRelativePath(file)) return undefined
              let resource: URL
              try {
                resource = new URL(file, skillUrl)
              } catch {
                return undefined
              }
              if (resource.origin !== skillUrl.origin) return undefined

              const destination = path.join(root, file)
              if (!FSUtil.contains(root, destination) || destination === root) return undefined
              return { url: resource.href, destination }
            })
            if (files.some((file) => file === undefined)) {
              yield* Effect.logWarning("skill file path is unsafe, skipping skill", { skill: skill.name })
              return null
            }

            yield* Effect.forEach(
              files as { url: string; destination: string }[],
              (file) => download(file.url, file.destination),
              {
                concurrency: fileConcurrency,
              },
            )

            const md = path.join(root, "SKILL.md")
            return (yield* fs.exists(md).pipe(Effect.orDie)) ? root : null
          }),
        { concurrency: skillConcurrency },
      )

      return dirs.filter((dir): dir is string => dir !== null)
    })

    return Service.of({ pull })
  }),
)

export const defaultLayer: Layer.Layer<Service> = layer.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(NodePath.layer),
)

export const node = LayerNode.make(layer, [FSUtil.node, path, httpClient])

export * as Discovery from "./discovery"
