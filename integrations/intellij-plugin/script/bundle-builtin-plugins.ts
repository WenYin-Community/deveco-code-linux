import { createRequire } from "node:module"
import path from "node:path"

export async function bundleBuiltinPlugins(destination: string, target: string) {
  const platforms = {
    "darwin-arm64": { os: "darwin", cpu: "arm64" },
    "darwin-x64": { os: "darwin", cpu: "x64" },
    "win32-x64": { os: "win32", cpu: "x64" },
    "win32-x64-baseline": { os: "win32", cpu: "x64" },
  } as const
  if (!(target in platforms)) throw new Error(`Unsupported CLI target: ${target}`)
  const platform = platforms[target as keyof typeof platforms]
  const manifest = path.resolve(destination, "package.json")
  const pkg = (await Bun.file(manifest).json()) as { dependencies?: Record<string, string> }
  const plugins = Object.keys(pkg.dependencies ?? {})
  if (!plugins.length) return

  // Studio extracts these files without running a package manager. Install at
  // build time for the target platform, including when cross-compiling.
  const proc = Bun.spawn(
    [
      process.execPath,
      "install",
      "--production",
      "--ignore-scripts",
      "--no-save",
      "--linker=hoisted",
      "--backend=copyfile",
      `--os=${platform.os}`,
      `--cpu=${platform.cpu}`,
    ],
    { cwd: path.dirname(manifest), stdout: "inherit", stderr: "inherit" },
  )
  if ((await proc.exited) !== 0) throw new Error("Failed to install bundled Studio plugins")

  const require = createRequire(manifest)
  for (const plugin of plugins) {
    require.resolve(`${plugin}/server`)
  }
  console.log(`Bundled Studio plugins for ${target}: ${plugins.join(", ")}`)
}

if (import.meta.main) {
  const [destination, target] = process.argv.slice(2)
  if (!destination || !target) throw new Error("Expected destination and CLI target")
  await bundleBuiltinPlugins(destination, target)
}
