import { createHash } from "node:crypto"
import { mkdir, mkdtemp, copyFile, chmod, rm, rename } from "node:fs/promises"
import path from "node:path"

// The vendored DevEco CLI currently resolves dependencies using RegExp /v,
// which Studio 6.1's Node 18 cannot parse. Ship a checked, portable runtime.
const version = "22.22.0"
const destination = process.argv[2]
const target = process.argv[3]
const platforms = {
  "darwin-arm64": { archive: `node-v${version}-darwin-arm64.tar.gz`, hash: "5ed4db0fcf1eaf84d91ad12462631d73bf4576c1377e192d222e48026a902640", root: `node-v${version}-darwin-arm64`, binary: "bin/node" },
  "darwin-x64": { archive: `node-v${version}-darwin-x64.tar.gz`, hash: "5ea50c9d6dea3dfa3abb66b2656f7a4e1c8cef23432b558d45fb538c7b5dedce", root: `node-v${version}-darwin-x64`, binary: "bin/node" },
  "win32-x64": { archive: `node-v${version}-win-x64.zip`, hash: "c97fa376d2becdc8863fcd3ca2dd9a83a9f3468ee7ccf7a6d076ec66a645c77a", root: `node-v${version}-win-x64`, binary: "node.exe" },
} as const
const normalized = target === "win32-x64-baseline" ? "win32-x64" : target
if (!destination || !normalized || !(normalized in platforms)) {
  throw new Error("Expected destination and target: darwin-arm64, darwin-x64, win32-x64 or win32-x64-baseline")
}
const selected = platforms[normalized as keyof typeof platforms]
const archive = selected.archive
const expected = selected.hash
const cache = path.resolve(import.meta.dir, "../../../packages/opencode/.build-cache/node")
await mkdir(cache, { recursive: true })
const tarball = path.join(cache, archive)
const valid = async () => (await Bun.file(tarball).exists()) &&
  createHash("sha256").update(new Uint8Array(await Bun.file(tarball).arrayBuffer())).digest("hex") === expected
if (!(await valid())) {
  const response = await fetch(`https://nodejs.org/dist/v${version}/${archive}`)
  if (!response.ok) throw new Error(`Node download failed: ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (createHash("sha256").update(bytes).digest("hex") !== expected) {
    throw new Error("Node archive SHA-256 mismatch")
  }
  const partial = `${tarball}.${process.pid}.tmp`
  await Bun.write(partial, bytes)
  await rename(partial, tarball)
}
const extracted = await mkdtemp(path.join(cache, "extract-"))
try {
  const result = archive.endsWith(".zip")
    ? process.platform === "win32"
      ? Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Expand-Archive -LiteralPath $env:DEVECO_NODE_ARCHIVE -DestinationPath $env:DEVECO_NODE_EXTRACT"], {
          env: { ...process.env, DEVECO_NODE_ARCHIVE: tarball, DEVECO_NODE_EXTRACT: extracted },
        })
      : Bun.spawnSync(["unzip", "-q", tarball, "-d", extracted])
    : Bun.spawnSync(["tar", "-xzf", tarball, "-C", extracted])
  if (result.exitCode !== 0) throw new Error(`Node extraction failed: ${new TextDecoder().decode(result.stderr)}`)
  const root = path.join(extracted, selected.root)
  const output = path.join(destination, "bin", selected.binary.endsWith(".exe") ? "node.exe" : "node")
  await mkdir(path.join(destination, "bin"), { recursive: true })
  await mkdir(path.join(destination, "licenses"), { recursive: true })
  await copyFile(path.join(root, selected.binary), output)
  if (process.platform !== "win32") await chmod(output, 0o755)
  await copyFile(path.join(root, "LICENSE"), path.join(destination, "licenses/node-LICENSE"))
  await Bun.write(path.join(destination, "licenses/node-version.txt"), `${version}\n${expected}  ${archive}\n`)
  console.log(`Bundled Node ${version} (${target}), SHA-256 verified`)
} finally {
  await rm(extracted, { recursive: true, force: true })
}
