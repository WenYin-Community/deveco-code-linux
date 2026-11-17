import { Effect } from "effect"
import path from "node:path"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LSP } from "@/lsp/lsp"

const MAX_PROJECT_DIAGNOSTICS_FILES = 5

export const fileWriteNotifier = Effect.gen(function* () {
  const events = yield* EventV2Bridge.Service
  const lsp = yield* LSP.Service

  return Effect.fn("Tool.notifyFileChange")(function* (input: { file: string; event: "add" | "change" }) {
    if (!path.isAbsolute(input.file)) throw new Error("File change notifications require an absolute path")
    const filepath = input.file
    yield* events.publish(FileSystem.Event.Edited, { file: filepath })
    yield* events.publish(Watcher.Event.Updated, { file: filepath, event: input.event })
    yield* lsp.touchFile(filepath, "document")
    const diagnostics = yield* lsp.diagnostics()
    const normalizedFilepath = FSUtil.normalizePath(filepath)
    let output = ""
    let projectDiagnosticsCount = 0
    for (const [file, issues] of Object.entries(diagnostics)) {
      const current = file === normalizedFilepath
      if (!current && projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
      const block = LSP.Diagnostic.report(current ? filepath : file, issues)
      if (!block) continue
      if (current) {
        output += `\n\nLSP errors detected in this file, please fix:\n${block}`
        continue
      }
      projectDiagnosticsCount++
      output += `\n\nLSP errors detected in other files:\n${block}`
    }
    return { output, diagnostics }
  })
})
