// Patched loader.js for @bitfun-ai/sandbox — adds bun compiled binary (bunfs) support.
// The upstream npm package uses realpathSync on bunfs virtual paths,
// which fails and throws "Sandbox wrapper package identity is invalid".
// This patch adds tryRealpath(), isBunfs(), and loadNativeFromBunfs() so the
// loader can find the vendored sandbox.node alongside the compiled binary.
import { createRequire } from "node:module"
import { createHash } from "node:crypto"
import { lstatSync, readFileSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { SandboxError, fromNativeError } from "./error.js"
const require = createRequire(import.meta.url)
const PACKAGE_NAME = "@bitfun-ai/sandbox"
const CONTRACT_GENERATION = 2
const NAPI_BASELINE = 8
/** realpathSync with fallback: in bun's compiled binary (bunfs), realpathSync
 *  fails on virtual paths like /$bunfs/root/...; fall back to the original
 *  path since bunfs paths are already canonical. */
function tryRealpath(p) {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}
function unsupported() {
  throw new SandboxError(
    "UnsupportedPlatform",
    "Configuration",
    "The current platform is not supported by this sandbox package",
  )
}
function packageName() {
  if (process.platform === "win32") {
    if (process.arch === "arm64") return "@bitfun-ai/sandbox-win32-arm64"
    if (process.arch === "x64") return "@bitfun-ai/sandbox-win32-x64"
    return unsupported()
  }
  if (process.platform !== "darwin") unsupported()
  if (process.arch === "arm64") return "@bitfun-ai/sandbox-darwin-arm64"
  if (process.arch === "x64") return "@bitfun-ai/sandbox-darwin-x64"
  return unsupported()
}
/** Detect if we're running inside bun's compiled binary (bunfs), where
 *  package.json and build-identity.json are not on the real filesystem. */
function isBunfs() {
  try {
    require.resolve(`${packageName()}/package.json`)
    return false
  } catch {
    // If package.json can't be resolved, we're likely in bunfs where
    // only the .node file is accessible via require().
    return true
  }
}
function inside(root, candidate) {
  const path = relative(root, candidate)
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
}
function parseIdentity(value) {
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new SandboxError(
      "SandboxExecutableIntegrityFailed",
      "Configuration",
      "Native sandbox build identity is invalid",
    )
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SandboxError(
      "SandboxExecutableIntegrityFailed",
      "Configuration",
      "Native sandbox build identity is invalid",
    )
  }
  const identity = parsed
  const keys = Object.keys(identity)
  const expected = ["package_version", "contract_generation", "target_os", "target_arch", "napi_baseline"]
  if (process.platform === "win32") expected.push("windows_unelevated_activation")
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) {
    throw new SandboxError(
      "SandboxExecutableIntegrityFailed",
      "Configuration",
      "Native sandbox build identity is invalid",
    )
  }
  return identity
}
function integrityError(message) {
  return new SandboxError("SandboxExecutableIntegrityFailed", "Configuration", message)
}
function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}
function findVendorDirectory() {
  const { existsSync } = require("node:fs")
  const { join } = require("node:path")
  const candidates = [
    join(process.execPath, "..", "..", "vendor", "sandbox"),
    join(process.execPath, "..", "vendor", "sandbox"),
  ]
  const vendorDir = candidates.find((candidate) => existsSync(join(candidate, "sandbox.node")))
  if (vendorDir) return vendorDir
  throw integrityError("Sandbox native addon not found in vendor directory. Expected at: " + candidates.join(" or "))
}
function loadNativeAddon(addonPath) {
  const native = require(addonPath)
  if (typeof native?.getBuildIdentityJson === "function" && typeof native?.SandboxRuntime === "function") return native
  throw integrityError("Native sandbox module exports are invalid")
}
function verifyBunfsStagedIdentity(staged, digest) {
  if (
    staged.contract_generation === CONTRACT_GENERATION &&
    staged.target_os === process.platform &&
    staged.target_arch === process.arch &&
    staged.napi_baseline === NAPI_BASELINE &&
    staged.sha256 === digest
  ) return
  throw integrityError("Native sandbox artifact digest or staged identity does not match")
}
function verifyBunfsWindowsLauncher(staged, vendorDir) {
  if (process.platform !== "win32") return
  const { join } = require("node:path")
  const launcherDigest = sha256(join(vendorDir, "bitfun-windows-sandbox-launcher.exe"))
  if (staged.windows_unelevated_activation === "supported" && staged.launcher_sha256 === launcherDigest) return
  throw integrityError("Windows sandbox launcher digest does not match staged identity")
}
function verifyBunfsNativeIdentity(identity, staged) {
  if (
    identity.contract_generation !== CONTRACT_GENERATION ||
    identity.target_os !== process.platform ||
    identity.target_arch !== process.arch ||
    identity.napi_baseline !== NAPI_BASELINE
  ) throw integrityError("Native sandbox module identity does not match the current host")
  if (identity.windows_unelevated_activation !== staged.windows_unelevated_activation) {
    throw integrityError("Native sandbox runtime identity does not match staged metadata")
  }
}
/** In bun's compiled binary, package.json and build-identity.json are not
 *  accessible on the real filesystem (they're in bunfs). The build script
 *  vendors sandbox.node and build-identity.json to dist/<target>/vendor/sandbox/.
 *  Locate them relative to the executable and load from the real filesystem. */
function loadNativeFromBunfs() {
  const { join } = require("node:path")
  const vendorDir = findVendorDirectory()
  const addonPath = join(vendorDir, "sandbox.node")
  const staged = JSON.parse(readFileSync(join(vendorDir, "build-identity.json"), "utf8"))
  verifyBunfsStagedIdentity(staged, sha256(addonPath))
  verifyBunfsWindowsLauncher(staged, vendorDir)
  const native = loadNativeAddon(addonPath)
  const identity = parseIdentity(native.getBuildIdentityJson())
  verifyBunfsNativeIdentity(identity, staged)
  return { ...native, bundleRoot: vendorDir }
}
function resolvePackageManifests(selected) {
  const wrapperManifestPath = tryRealpath(require.resolve(`${PACKAGE_NAME}/package.json`))
  const wrapperManifest = JSON.parse(readFileSync(wrapperManifestPath, "utf8"))
  if (
    wrapperManifest.name !== PACKAGE_NAME ||
    typeof wrapperManifest.version !== "string" ||
    wrapperManifest.version.length === 0
  ) throw integrityError("Sandbox wrapper package identity is invalid")
  const manifestPath = tryRealpath(require.resolve(`${selected}/package.json`))
  const packageRoot = tryRealpath(dirname(manifestPath))
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  if (manifest.name !== selected || manifest.version !== wrapperManifest.version) {
    throw integrityError("Native sandbox package identity does not match the wrapper")
  }
  return { packageVersion: wrapperManifest.version, packageRoot }
}
function resolvePackageFile(packageRoot, name, message) {
  const candidate = tryRealpath(resolve(packageRoot, name))
  if (inside(packageRoot, candidate) && lstatSync(candidate).isFile()) return candidate
  throw integrityError(message)
}
function verifyFilesystemStagedIdentity(staged, packageVersion, digest) {
  const activation = staged.windows_unelevated_activation
  if (
    staged.package_version === packageVersion &&
    staged.contract_generation === CONTRACT_GENERATION &&
    staged.target_os === process.platform &&
    staged.target_arch === process.arch &&
    staged.napi_baseline === NAPI_BASELINE &&
    (process.platform !== "win32" || activation === "unsupported" || activation === "supported") &&
    staged.sha256 === digest
  ) return
  throw integrityError("Native sandbox artifact digest or staged identity does not match")
}
function verifyFilesystemWindowsLauncher(staged, packageRoot) {
  if (process.platform !== "win32") return
  const launcherPath = resolvePackageFile(
    packageRoot,
    "bitfun-windows-sandbox-launcher.exe",
    "Windows sandbox launcher is outside its platform package",
  )
  if (staged.launcher_sha256 === sha256(launcherPath)) return
  throw integrityError("Windows sandbox launcher digest does not match staged identity")
}
function verifyNativeHostIdentity(identity, packageVersion) {
  if (
    identity.package_version === packageVersion &&
    identity.contract_generation === CONTRACT_GENERATION &&
    identity.target_os === process.platform &&
    identity.target_arch === process.arch &&
    identity.napi_baseline === NAPI_BASELINE
  ) return
  throw integrityError("Native sandbox module identity does not match the current host")
}
function verifyNativeStagedIdentity(identity, staged) {
  if (
    identity.package_version === staged.package_version &&
    identity.contract_generation === staged.contract_generation &&
    identity.target_os === staged.target_os &&
    identity.target_arch === staged.target_arch &&
    identity.napi_baseline === staged.napi_baseline &&
    identity.windows_unelevated_activation === staged.windows_unelevated_activation
  ) return
  throw integrityError("Native sandbox runtime identity does not match staged metadata")
}
/** On a normal filesystem (dev mode), perform full integrity verification:
 *  package.json version match, SHA256 digest of the .node file, staged
 *  build-identity.json cross-check, and native getBuildIdentityJson() check. */
function loadNativeFromFilesystem() {
  const selected = packageName()
  const manifests = resolvePackageManifests(selected)
  const addonPath = resolvePackageFile(
    manifests.packageRoot,
    "sandbox.node",
    "Native sandbox module is outside its platform package",
  )
  const metadataPath = resolvePackageFile(
    manifests.packageRoot,
    "build-identity.json",
    "Native sandbox build metadata is outside its platform package",
  )
  const staged = JSON.parse(readFileSync(metadataPath, "utf8"))
  verifyFilesystemStagedIdentity(staged, manifests.packageVersion, sha256(addonPath))
  verifyFilesystemWindowsLauncher(staged, manifests.packageRoot)
  const native = loadNativeAddon(addonPath)
  const identity = parseIdentity(native.getBuildIdentityJson())
  verifyNativeHostIdentity(identity, manifests.packageVersion)
  verifyNativeStagedIdentity(identity, staged)
  return { ...native, bundleRoot: manifests.packageRoot }
}
export function loadNative() {
  try {
    if (isBunfs()) return loadNativeFromBunfs()
    return loadNativeFromFilesystem()
  } catch (error) {
    if (error instanceof SandboxError) throw error
    throw fromNativeError(error)
  }
}
