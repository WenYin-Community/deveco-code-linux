export * as ConfigPaths from "./paths"

import path from "path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { unique } from "remeda"
import * as Effect from "effect/Effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Runtime } from "@opencode-ai/core/runtime"

export const files = Effect.fn("ConfigPaths.projectFiles")(function* (
  name: string,
  directory: string,
  worktree?: string,
) {
  const afs = yield* FSUtil.Service
  return (yield* afs.up({
    targets: [`${name}.jsonc`, `${name}.json`],
    start: directory,
    stop: worktree,
  })).toReversed()
})

export const directories = Effect.fn("ConfigPaths.directories")(function* (
  directory: string,
  worktree?: string,
  projectID?: string,
) {
  const afs = yield* FSUtil.Service
  return unique([
    Global.Path.config,
    ...(Runtime.current.configSources.project && !Flag.DEVECO_DISABLE_PROJECT_CONFIG
      ? yield* afs.up({
          targets: [".deveco"],
          start: directory,
          stop: worktree,
        })
      : []),
    ...(Runtime.current.configSources.home
      ? yield* afs.up({
          targets: [".deveco"],
          start: Global.Path.home,
          stop: Global.Path.home,
        })
      : []),
    ...(Runtime.current.configSources.explicit && Flag.DEVECO_CONFIG_DIR ? [Flag.DEVECO_CONFIG_DIR] : []),
    ...(Runtime.current.mode === "deveco-studio" && projectID ? [Global.projectConfig(projectID)] : []),
  ])
})

export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.jsonc`), path.join(dir, `${name}.json`)]
}
