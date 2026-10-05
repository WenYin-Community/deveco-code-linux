import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { sanitizePath } from "@opencode-ai/core/sanitize-path"
import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "@/lsp/lsp"
import { Snapshot } from "../snapshot"
import * as Project from "./project"
import * as Vcs from "./vcs"
import { InstanceState } from "@/effect/instance-state"
import { ShareNext } from "@/share/share-next"
import { Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { Service } from "./bootstrap-service"
import { clearRuntimeSandbox } from "@opencode-ai/core/config/runtime-sandbox"
import { clearStaleSandboxPids } from "@opencode-ai/core/config/sandbox-pids"
import { execSync } from "node:child_process"

// FR-EXEC-006: Collect descendant PIDs via pgrep -P for stale process cleanup.
// Used only on macOS at bootstrap to kill orphaned sandbox-exec trees.
function collectDescendants(pid: number): number[] {
  if (process.platform === "win32") return []
  const pids: number[] = []
  const queue = [pid]
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]
    try {
      const text = execSync(`pgrep -P ${current}`, { encoding: "utf-8", timeout: 2000 })
      for (const tok of text.split("\n")) {
        const cpid = parseInt(tok, 10)
        if (!isNaN(cpid) && !pids.includes(cpid)) {
          pids.push(cpid)
          queue.push(cpid)
        }
      }
    } catch {}
  }
  return pids
}

export { Service } from "./bootstrap-service"
export type { Interface } from "./bootstrap-service"

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Yield each bootstrap dep at layer init so `run` itself has R = never.
    // InstanceStore imports only the lightweight tag from bootstrap-service.ts,
    // so it can depend on bootstrap without importing this implementation graph.
    const config = yield* Config.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const plugin = yield* Plugin.Service
    const project = yield* Project.Service
    const shareNext = yield* ShareNext.Service
    const snapshot = yield* Snapshot.Service
    const vcs = yield* Vcs.Service

    const run = Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      yield* Effect.logInfo("bootstrapping", { directory: sanitizePath(ctx.directory) })
      // Clear stale runtime sandbox override from a previous session (S-SESS-1, FR-UI-006).
      yield* Effect.promise(() => clearRuntimeSandbox())
      // FR-EXEC-006: Kill orphaned sandbox-exec processes from a crashed/killed host.
      if (process.platform === "darwin") {
        yield* Effect.promise(() => clearStaleSandboxPids(async (pid) => collectDescendants(pid)))
      }
      // everything depends on config so eager load it for nice traces
      yield* config.get()
      // Plugin can mutate config so it has to be initialized before anything else.
      yield* plugin.init()
      // Each service self-manages its own slow work via Effect.forkScoped against
      // its per-instance state scope. We just await materialization here.
      yield* Effect.forEach(
        [lsp, shareNext, format, vcs, snapshot, project],
        (s) => s.init().pipe(Effect.catchCause((cause) => Effect.logWarning("init failed", { cause }))),
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.withSpan("InstanceBootstrap.init"))
    }).pipe(Effect.withSpan("InstanceBootstrap"))

    return Service.of({ run })
  }),
)

export const defaultLayer: Layer.Layer<Service> = layer.pipe(
  Layer.provide([
    Config.defaultLayer,
    Format.defaultLayer,
    LSP.defaultLayer,
    Plugin.defaultLayer,
    Project.defaultLayer,
    ShareNext.defaultLayer,
    Snapshot.defaultLayer,
    Vcs.defaultLayer,
  ]),
)

export const node = LayerNode.make(layer, [
  Config.node,
  Format.node,
  LSP.node,
  Plugin.node,
  Project.node,
  ShareNext.node,
  Snapshot.node,
  Vcs.node,
])

export * as InstanceBootstrap from "./bootstrap"
