import path from "path"
import fs from "fs/promises"
import { xdgData, xdgCache, xdgConfig, xdgState } from "xdg-basedir"
import os from "os"
import { Context, Effect, Layer } from "effect"
import { Flock } from "./util/flock"
import { Flag } from "./flag/flag"
import { LayerNode } from "./effect/layer-node"
import { Runtime } from "./runtime"

const app = "deveco"
const data = Runtime.current.storageRoot ? path.join(Runtime.current.storageRoot, "data") : path.join(xdgData!, app)
const cache = Runtime.current.storageRoot ? path.join(Runtime.current.storageRoot, "cache") : path.join(xdgCache!, app)
const config = Runtime.current.storageRoot
  ? path.join(Runtime.current.storageRoot, "config")
  : path.join(xdgConfig!, app)
const state = Runtime.current.storageRoot ? path.join(Runtime.current.storageRoot, "state") : path.join(xdgState!, app)
const tmp = Runtime.current.storageRoot ? path.join(Runtime.current.storageRoot, "tmp") : path.join(os.tmpdir(), app)

const paths = {
  get home() {
    return process.env.DEVECO_TEST_HOME ?? os.homedir()
  },
  data,
  bin: path.join(cache, "bin"),
  log: path.join(data, "log"),
  repos: path.join(data, "repos"),
  cache,
  config,
  state,
  tmp,
}

export const Path = paths

export function projectConfig(projectID: string) {
  const safe = projectID.replace(/[^a-zA-Z0-9._-]/g, "_") || "global"
  return path.join(Path.config, "projects", safe, ".deveco")
}

Flock.setGlobal({ state })

await Promise.all([
  fs.mkdir(Path.data, { recursive: true }),
  fs.mkdir(Path.config, { recursive: true }),
  fs.mkdir(Path.state, { recursive: true }),
  fs.mkdir(Path.tmp, { recursive: true }),
  fs.mkdir(Path.log, { recursive: true }),
  fs.mkdir(Path.bin, { recursive: true }),
  fs.mkdir(Path.repos, { recursive: true }),
])

export class Service extends Context.Service<Service, Interface>()("@opencode/Global") {}

export interface Interface {
  readonly home: string
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly state: string
  readonly tmp: string
  readonly bin: string
  readonly log: string
  readonly repos: string
}

export function make(input: Partial<Interface> = {}): Interface {
  return {
    home: Path.home,
    data: Path.data,
    cache: Path.cache,
    config: Runtime.current.configSources.explicit ? (Flag.DEVECO_CONFIG_DIR ?? Path.config) : Path.config,
    state: Path.state,
    tmp: Path.tmp,
    bin: Path.bin,
    log: Path.log,
    repos: Path.repos,
    ...input,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.sync(() => Service.of(make())),
)

export const defaultLayer = layer
export const node = LayerNode.make(layer, [])

export const layerWith = (input: Partial<Interface>) =>
  Layer.effect(
    Service,
    Effect.sync(() => Service.of(make(input))),
  )

export * as Global from "./global"
