import fs from "node:fs/promises"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"

export const RUNTIME = JSON.parse(await fs.readFile(new URL("./lanhu-runtime-lock.json", import.meta.url), "utf8"))

// Resolve only pinned modules installed outside the skill and project bundles.
export async function runtimeDependency(runtime, name) {
  const expected = RUNTIME.nodeDependencies[name]
  if (!expected) throw new Error("Unknown Lanhu runtime dependency")
  const root = resolve(runtime)
  const packageRoot = join(root, "node_modules", name)
  const manifest = JSON.parse(await fs.readFile(join(packageRoot, "package.json"), "utf8"))
  if (manifest.version !== expected) throw new Error(`Install ${name}@${expected} in the selected runtime`)
  const require = createRequire(join(root, "package.json"))
  return import(pathToFileURL(require.resolve(name)).href)
}

export function isMain(url) {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(url)
}
