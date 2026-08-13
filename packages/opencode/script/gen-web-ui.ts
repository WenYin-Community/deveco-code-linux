#!/usr/bin/env bun

import path from "path"
import { Script } from "@opencode-ai/script"

const dir = path.resolve(import.meta.dirname, "..")
const appDir = path.join(dir, "../app")
const dist = path.join(appDir, "dist")

export async function buildWebUI(): Promise<string> {
  await Bun.$`DEVECO_CHANNEL=${Script.channel} bun run --cwd ${appDir} build`
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dist })))
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.endsWith(".map"))
    .sort()

  const imports = files.map((file, i) => {
    const spec = path.relative(dir, path.join(dist, file)).replaceAll("\\", "/")
    return `import file_${i} from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)} with { type: "file" };`
  })
  const entries = files.map((file, i) => `  ${JSON.stringify(file)}: file_${i},`)
  return [
    `// @ts-nocheck`,
    `// Auto-generated. Do not edit.`,
    ...imports,
    `export default {`,
    ...entries,
    `}`,
  ].join("\n")
}

const outPath = path.join(dir, "deveco-web-ui.gen.ts")
const content = await buildWebUI()
await Bun.write(outPath, content)
console.log(`Generated ${path.relative(dir, outPath)} (${content.split("\n").length} lines)`)
