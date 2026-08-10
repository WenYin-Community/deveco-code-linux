/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from "fs"
import path from "path"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import * as Truncate from "./truncate"
import { getSessionCwd } from "./lib/session-cwd"
import { buildDevecoCliBuildArgs, runBundledDevecoCli } from "./lib/deveco-cli"
import { formatBuildProjectOutput, TRUNCATE_NOTICE } from "./lib/build-project-output"
import DESCRIPTION from "./build-project.txt"

export {
  formatBuildProjectOutput,
  formatBuildStatusLine,
  formatStdoutStderr,
  truncateOutput,
} from "./lib/build-project-output"

const Parameters = Schema.Struct({
  clean: Schema.optional(Schema.Boolean).annotate({
    description: "Whether to remove existing build outputs before the build starts. Use true only when the user explicitly asks for a clean build, cache clearing, or a full rebuild. Otherwise, keep it false.",
  }),
  product: Schema.optional(Schema.String).annotate({
    description:
      "Product name defined in build-profile.json5. Builds the whole product bundle (.app) when set without modules. Defaults to `default` when omitted.",
  }),
  modules: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Modules to build. Format: module name or module@target (e.g. `entry`, `library@phone`). Omit for single entry or default whole-app behavior.",
  }),
  build_mode: Schema.optional(Schema.String).annotate({
    description:
      "Build mode from buildModeSet in build-profile.json5 (e.g. debug, release). Defaults to debug when omitted.",
  }),
})

interface BuildProjectMetadata {
  exitCode?: number
  command?: string
  truncated?: boolean
  outputPath?: string
}

function resolveProjectRoot(sessionID: string | undefined, fallback: string) {
  const sessionDir = sessionID ? getSessionCwd(sessionID) : undefined
  return path.resolve(sessionDir ?? fallback)
}

export const BuildProjectTool = Tool.define("build_project", Effect.gen(function* () {
  const truncate = yield* Truncate.Service
  return {
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (args: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<BuildProjectMetadata>) =>
      Effect.gen(function* () {
        const cwd = resolveProjectRoot(ctx.sessionID, process.cwd())
        if (!fs.existsSync(path.join(cwd, "build-profile.json5"))) {
          throw new Error(
            `HarmonyOS project not found at ${cwd}. Run switch_cwd to the project root or scaffold a project first.`,
          )
        }

        const cliArgs = buildDevecoCliBuildArgs({
          clean: args.clean,
          product: args.product,
          modules: args.modules,
          build_mode: args.build_mode,
        })
        const command = `devecocli ${cliArgs.join(" ")}`

        const result = yield* Effect.tryPromise(() => runBundledDevecoCli(cliArgs, cwd))

        const cut = formatBuildProjectOutput({
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        })
        let output = cut.text
        let outputPath: string | undefined
        if (cut.truncated) {
          outputPath = yield* truncate.write(cut.full)
          output = `${TRUNCATE_NOTICE}\n\nFull output saved to: ${outputPath}\n\n${cut.preview}`
        }

        return {
          title: command,
          output,
          metadata: {
            exitCode: result.exitCode,
            command,
            truncated: cut.truncated,
            ...(outputPath ? { outputPath } : {}),
          },
        }
      }).pipe(Effect.orDie),
  }
}))
