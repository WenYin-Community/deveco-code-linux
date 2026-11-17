import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { resolveInstallRoot } from "@opencode-ai/core/installation/vendor-path"
import type { ConfigPlugin } from "@/config/plugin"
import pkg from "../../package.json"

export const ID = "deveco-harness"
export const PACKAGE = "@deveco-test/deveco-harness"
export const VERSION = pkg.builtinPlugins[PACKAGE]

export function origin(input: {
  root?: string
  disableDefaultPlugins: boolean
  pure: boolean
}): ConfigPlugin.Origin | undefined {
  if (input.disableDefaultPlugins || input.pure) return
  // Resolve from the installed npm host, including hoisted dependencies. The
  // compiled binary's import.meta.url points into bunfs, not node_modules.
  // irm copies the launcher outside the version directory. Reuse the existing
  // resource root as a fallback while keeping the npm host's dependency first.
  const roots = [input.root ?? path.resolve(path.dirname(process.execPath), ".."), resolveInstallRoot()]
  // Source checkouts install the same plugin spec as a normal package dependency.
  if (!input.root) roots.unshift(path.resolve(import.meta.dirname, "../.."))
  for (const root of roots) {
    try {
      const entry = createRequire(path.join(root, "package.json")).resolve(`${PACKAGE}/server`)
      return { spec: pathToFileURL(entry).href, source: "builtin:deveco-harness", scope: "global" }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND") continue
      throw error
    }
  }
}

export * as BuiltinHarness from "./builtin-harness"
