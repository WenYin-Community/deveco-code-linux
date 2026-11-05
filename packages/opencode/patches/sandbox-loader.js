// Patched loader.js for @bitfun-ai/sandbox — adds bun compiled binary (bunfs) support.
// The upstream npm package (0.2.19) uses realpathSync on bunfs virtual paths,
// which fails and throws "Sandbox wrapper package identity is invalid".
// This patch adds tryRealpath(), isBunfs(), and loadNativeFromBunfs() so the
// loader can find the vendored sandbox.node alongside the compiled binary.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { SandboxError, fromNativeError } from "./error.js";
const require = createRequire(import.meta.url);
const PACKAGE_NAME = "@bitfun-ai/sandbox";
const CONTRACT_GENERATION = 1;
const NAPI_BASELINE = 8;
/** realpathSync with fallback: in bun's compiled binary (bunfs), realpathSync
 *  fails on virtual paths like /$bunfs/root/...; fall back to the original
 *  path since bunfs paths are already canonical. */
function tryRealpath(p) {
    try {
        return realpathSync(p);
    }
    catch {
        return p;
    }
}
function unsupported() {
    throw new SandboxError("UnsupportedPlatform", "Configuration", "The current platform is not supported by this sandbox package");
}
function packageName() {
    if (process.platform === "win32")
        unsupported();
    if (process.platform !== "darwin")
        unsupported();
    if (process.arch === "arm64")
        return "@bitfun-ai/sandbox-darwin-arm64";
    if (process.arch === "x64")
        return "@bitfun-ai/sandbox-darwin-x64";
    return unsupported();
}
/** Detect if we're running inside bun's compiled binary (bunfs), where
 *  package.json and build-identity.json are not on the real filesystem. */
function isBunfs() {
    try {
        require.resolve(`${packageName()}/package.json`);
        return false;
    }
    catch {
        // If package.json can't be resolved, we're likely in bunfs where
        // only the .node file is accessible via require().
        return true;
    }
}
function inside(root, candidate) {
    const path = relative(root, candidate);
    return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}
function parseIdentity(value) {
    let parsed;
    try {
        parsed = JSON.parse(value);
    }
    catch {
        throw new SandboxError("SandboxExecutableIntegrityFailed", "Configuration", "Native sandbox build identity is invalid");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new SandboxError("SandboxExecutableIntegrityFailed", "Configuration", "Native sandbox build identity is invalid");
    }
    const identity = parsed;
    const keys = Object.keys(identity);
    const expected = ["package_version", "contract_generation", "target_os", "target_arch", "napi_baseline"];
    if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) {
        throw new SandboxError("SandboxExecutableIntegrityFailed", "Configuration", "Native sandbox build identity is invalid");
    }
    return identity;
}
/** In bun's compiled binary, package.json and build-identity.json are not
 *  accessible on the real filesystem (they're in bunfs). The build script
 *  vendors sandbox.node and build-identity.json to dist/<target>/vendor/sandbox/.
 *  Locate them relative to the executable and load from the real filesystem. */
function loadNativeFromBunfs() {
    const { existsSync } = require("node:fs");
    const { join } = require("node:path");
    const exePath = process.execPath;
    const candidates = [
        join(exePath, "..", "..", "vendor", "sandbox"),
        join(exePath, "..", "vendor", "sandbox"),
        join(process.cwd(), "vendor", "sandbox"),
    ];
    let vendorDir = null;
    for (const candidate of candidates) {
        if (existsSync(join(candidate, "sandbox.node"))) {
            vendorDir = candidate;
            break;
        }
    }
    if (!vendorDir) {
        throw new SandboxError("SandboxExecutableIntegrityFailed", "Configuration", "Sandbox native addon not found in vendor directory. Expected at: " + candidates.join(" or "));
    }
    const addonPath = join(vendorDir, "sandbox.node");
    const native = require(addonPath);
    if (typeof native?.getBuildIdentityJson !== "function" || typeof native?.SandboxRuntime !== "function") {
        throw new SandboxError("SandboxExecutableIntegrityFailed", "Configuration", "Native sandbox module exports are invalid");
    }
    const identity = parseIdentity(native.getBuildIdentityJson());
    if (identity.contract_generation !== CONTRACT_GENERATION ||
        identity.target_os !== process.platform ||
        identity.target_arch !== process.arch ||
        identity.napi_baseline !== NAPI_BASELINE) {
        throw new SandboxError("SandboxExecutableIntegrityFailed", "Configuration", "Native sandbox module identity does not match the current host");
    }
    return native;
}
/** On a normal filesystem (dev mode), perform full integrity verification:
 *  package.json version match, SHA256 digest of the .node file, staged
 *  build-identity.json cross-check, and native getBuildIdentityJson() check. */
function loadNativeFromFilesystem() {
    const selected = packageName();
    const { packageVersion, packageRoot } = resolvePackageManifests(selected);
    const addonPath = tryRealpath(resolve(packageRoot, "sandbox.node"));
    if (!inside(packageRoot, addonPath) || !lstatSync(addonPath).isFile()) {
        throw new SandboxError("SandboxExecutableIntegrityFailed", "Configuration", "Native sandbox module is outside its platform package");
    }
    const metadataPath = tryRealpath(resolve(packageRoot, "build-identity.json"));
    if (!inside(packageRoot, metadataPath) || !lstatSync(metadataPath).isFile()) {
        throw new SandboxError("SandboxExecutableIntegrityFailed", "Configuration", "Native sandbox build metadata is outside its platform package");
    }
    const staged = JSON.parse(readFileSync(metadataPath, "utf8"));
    const digest = createHash("sha256").update(readFileSync(addonPath)).digest("hex");
    if (!verifyStagedIdentity(staged, packageVersion, digest)) {
        throw new SandboxError("SandboxExecutableIntegrityFailed", "Configuration", "Native sandbox artifact digest or staged identity does not match");
    }
    const native = require(addonPath);
    if (typeof native.getBuildIdentityJson !== "function" || typeof native.SandboxRuntime !== "function") {
        throw new SandboxError("SandboxExecutableIntegrityFailed", "Configuration", "Native sandbox module exports are invalid");
    }
    const identity = parseIdentity(native.getBuildIdentityJson());
    if (!verifyHostIdentity(identity, packageVersion)) {
        throw new SandboxError("SandboxExecutableIntegrityFailed", "Configuration", "Native sandbox module identity does not match the current host");
    }
    if (!verifyIdentityMatch(identity, staged)) {
        throw new SandboxError("SandboxExecutableIntegrityFailed", "Configuration", "Native sandbox runtime identity does not match staged metadata");
    }
    return native;
}

function resolvePackageManifests(selected) {
    const wrapperManifestPath = tryRealpath(require.resolve(`${PACKAGE_NAME}/package.json`));
    const wrapperManifest = JSON.parse(readFileSync(wrapperManifestPath, "utf8"));
    if (wrapperManifest.name !== PACKAGE_NAME || typeof wrapperManifest.version !== "string" || wrapperManifest.version.length === 0) {
        throw new SandboxError("SandboxExecutableIntegrityFailed", "Configuration", "Sandbox wrapper package identity is invalid");
    }
    const packageVersion = wrapperManifest.version;
    const manifestPath = tryRealpath(require.resolve(`${selected}/package.json`));
    const packageRoot = tryRealpath(dirname(manifestPath));
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.name !== selected || manifest.version !== packageVersion) {
        throw new SandboxError("SandboxExecutableIntegrityFailed", "Configuration", "Native sandbox package identity does not match the wrapper");
    }
    return { wrapperManifest, packageVersion, packageRoot, manifest };
}

function verifyStagedIdentity(staged, packageVersion, digest) {
    return staged.package_version === packageVersion &&
        staged.contract_generation === CONTRACT_GENERATION &&
        staged.target_os === process.platform &&
        staged.target_arch === process.arch &&
        staged.napi_baseline === NAPI_BASELINE &&
        staged.sha256 === digest;
}

function verifyHostIdentity(identity, packageVersion) {
    return identity.package_version === packageVersion &&
        identity.contract_generation === CONTRACT_GENERATION &&
        identity.target_os === process.platform &&
        identity.target_arch === process.arch &&
        identity.napi_baseline === NAPI_BASELINE;
}

function verifyIdentityMatch(identity, staged) {
    return identity.package_version === staged.package_version &&
        identity.contract_generation === staged.contract_generation &&
        identity.target_os === staged.target_os &&
        identity.target_arch === staged.target_arch &&
        identity.napi_baseline === staged.napi_baseline;
}
export function loadNative() {
    try {
        if (isBunfs())
            return loadNativeFromBunfs();
        return loadNativeFromFilesystem();
    }
    catch (error) {
        if (error instanceof SandboxError)
            throw error;
        throw fromNativeError(error);
    }
}
