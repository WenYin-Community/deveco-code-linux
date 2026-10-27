import path from "node:path"
import fs from "node:fs"
import type { HdcOperation } from "./operation"
import type { HdcGuardTrustedContext, ReasonCode } from "./decision"
import { readHapBundleName } from "./hap"

// ─── Validation context: combines request cwd with trusted context ──
export interface ValidationContext {
  cwd: string
  workspaceRoot: string
  targetDevice: HdcGuardTrustedContext["targetDevice"]
  projectBundles: readonly string[]
}

// ─── Validation result ─────────────────────────────────────
export type ValidationResult =
  | { _tag: "valid" }
  | { _tag: "invalid"; reasonCode: ReasonCode; detail: string }

// ─── Validators (AR-SEC2-002) ──────────────────────────────
// Object validation failures must take effect before Permission
// can widen. Not overridable by config, saved permission, or approval.

// ─── fs error classification (shared by input/output validators) ──
// 区分 "路径确实不存在" 与 "权限不足无法访问" 两种情况
// - "not_found": 路径不存在 (ENOENT), input 视为拒绝, output 视为可创建
// - "permission_denied": 权限不足 (EACCES/EPERM), 一律拒绝并带上原始错误码
// - "other": 其他错误, 一律拒绝并带上原始错误码
type FsErrorClass = "not_found" | "permission_denied" | "other"

function classifyFsError(err: unknown): FsErrorClass {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code
  if (code === "ENOENT") return "not_found"
  if (code === "EACCES" || code === "EPERM") return "permission_denied"
  return "other"
}

// ─── Local path validators ─────────────────────────────────

export function validateLocalInput(localPath: string, ctx: ValidationContext): ValidationResult {
  const resolved = resolveLocalPath(localPath, ctx.cwd)

  if (!isWithinWorkspace(resolved, ctx.workspaceRoot)) {
    return {
      _tag: "invalid",
      reasonCode: "local_path_denied",
      detail: "path is outside workspace root",
    }
  }

  // specs §2.5.3: "普通文件类型" — must be a regular file, not link/dir/device.
  // AR §6: "只要求判断时校验" — synchronous fs check at decision time is allowed.
  let stats: fs.Stats
  try {
    // Use lstat to detect symlinks/hard links explicitly.
    stats = fs.lstatSync(resolved)
  } catch (err) {
    const cls = classifyFsError(err)
    if (cls === "not_found") {
      return {
        _tag: "invalid",
        reasonCode: "local_path_denied",
        detail: "input path does not exist",
      }
    }
    // permission_denied / other: 路径可能存在但无法访问, 一律拒绝并带上错误码便于诊断
    const code = (err as NodeJS.ErrnoException | null | undefined)?.code ?? "UNKNOWN"
    return {
      _tag: "invalid",
      reasonCode: "local_path_denied",
      detail: `input path not accessible (errno: ${code})`,
    }
  }

  if (stats.isSymbolicLink()) {
    return {
      _tag: "invalid",
      reasonCode: "local_path_denied",
      detail: "input path is a symbolic link, not a regular file",
    }
  }

  if (!stats.isFile()) {
    return {
      _tag: "invalid",
      reasonCode: "local_path_denied",
      detail: "input path is not a regular file",
    }
  }

  return { _tag: "valid" }
}

export function validateLocalOutput(localPath: string, ctx: ValidationContext): ValidationResult {
  const resolved = resolveLocalPath(localPath, ctx.cwd)

  if (!isWithinWorkspace(resolved, ctx.workspaceRoot)) {
    return {
      _tag: "invalid",
      reasonCode: "local_path_denied",
      detail: "output path is outside workspace root",
    }
  }

  // specs §2.5.3: "输出路径的父目录、覆盖策略、symlink/hard-link 和 file identity 必须校验"
  // 1. Reject if the output path itself is a symlink (could be redirected outside workspace).
  // 2. Parent directory must exist and be writable (creatable output condition).
  try {
    const outStats = fs.lstatSync(resolved)
    if (outStats.isSymbolicLink()) {
      return {
        _tag: "invalid",
        reasonCode: "local_path_denied",
        detail: "output path is a symbolic link",
      }
    }
  } catch (err) {
    // 输出路径允许不存在 (可以创建); 但权限不足仍要拒绝
    const cls = classifyFsError(err)
    if (cls !== "not_found") {
      const code = (err as NodeJS.ErrnoException | null | undefined)?.code ?? "UNKNOWN"
      return {
        _tag: "invalid",
        reasonCode: "local_path_denied",
        detail: `output path not accessible (errno: ${code})`,
      }
    }
    // not_found: 正常, 继续检查父目录
  }

  const parentDir = path.dirname(resolved)
  try {
    const parentStats = fs.statSync(parentDir)
    if (!parentStats.isDirectory()) {
      return {
        _tag: "invalid",
        reasonCode: "local_path_denied",
        detail: "parent of output path is not a directory",
      }
    }
    fs.accessSync(parentDir, fs.constants.W_OK)
  } catch (err) {
    const cls = classifyFsError(err)
    if (cls === "not_found") {
      return {
        _tag: "invalid",
        reasonCode: "local_path_denied",
        detail: "parent directory of output path does not exist",
      }
    }
    const code = (err as NodeJS.ErrnoException | null | undefined)?.code ?? "UNKNOWN"
    return {
      _tag: "invalid",
      reasonCode: "local_path_denied",
      detail: `parent directory of output path not writable (errno: ${code})`,
    }
  }

  return { _tag: "valid" }
}

// ─── Device path validators ────────────────────────────────

const DEVICE_PATH_ALLOWLIST: readonly (string | RegExp)[] = [
  "/data/",
  "/sdcard/",
  "/storage/",
]

export function validateDevicePath(devicePath: string): ValidationResult {
  // FR-OBJECT-002 (path equivalence): normalize `..` segments first so a
  // prefix match cannot be tricked into writing outside the allowlist
  // (e.g. /data/../system/bin/x normalizes to /system/bin/x). Paths that
  // cannot be safely normalized (relative, NUL, or unresolved `..`) fail
  // closed rather than guessing what the device-side shell would do.
  const normalized = normalizeDevicePath(devicePath)
  if (!normalized) {
    return {
      _tag: "invalid",
      reasonCode: "device_path_denied",
      detail: "device path is not an absolute, normalization-safe path",
    }
  }

  const matched = DEVICE_PATH_ALLOWLIST.some((entry) => {
    if (typeof entry === "string") return normalized.startsWith(entry)
    return entry.test(normalized)
  })

  if (!matched) {
    return {
      _tag: "invalid",
      reasonCode: "device_path_denied",
      detail: "device path is not in allowlist",
    }
  }

  return { _tag: "valid" }
}

// Normalize a POSIX-style device path before allowlist matching.
// Returns undefined (fail closed) for relative paths, NUL bytes, or
// paths whose `..` segments do not fully resolve.
function normalizeDevicePath(devicePath: string): string | undefined {
  if (devicePath.includes("\0")) return undefined
  if (!devicePath.startsWith("/")) return undefined
  const normalized = path.posix.normalize(devicePath)
  if (normalized.split("/").includes("..")) return undefined
  return normalized
}

// ─── Endpoint validators ───────────────────────────────────

const ENDPOINT_ALLOWLIST: readonly (string | RegExp)[] = [
  /^localhost:\d+$/,
  /^127\.0\.0\.1:\d+$/,
]

export function validateEndpoint(endpoint: string): ValidationResult {
  const matched = ENDPOINT_ALLOWLIST.some((entry) => {
    if (typeof entry === "string") return endpoint === entry
    return entry.test(endpoint)
  })

  if (!matched) {
    return {
      _tag: "invalid",
      reasonCode: "endpoint_not_allowed",
      detail: "endpoint is not in allowlist",
    }
  }

  return { _tag: "valid" }
}

// ─── Port validators ───────────────────────────────────────

const ALLOWED_PORT_RANGES: readonly { min: number; max: number }[] = [
  { min: 1024, max: 65535 },
]

export function validatePort(port: number): ValidationResult {
  const matched = ALLOWED_PORT_RANGES.some((r) => port >= r.min && port <= r.max)
  if (!matched) {
    return {
      _tag: "invalid",
      reasonCode: "endpoint_not_allowed",
      detail: `port ${port} is not in allowed range`,
    }
  }
  return { _tag: "valid" }
}

// ─── Param validators ──────────────────────────────────────

// Read-only param prefixes: param set on these is always deny.
// The OS returns PARAM_CODE_READ_ONLY (107) for these; HDC Guard
// denies before the command reaches the device, consistent with
// how system bundle uninstall is hard-denied before Permission.
const READONLY_PARAM_PREFIXES: readonly string[] = [
  "const.",
  "ro.",
  "ohos.boot.",
]

// Param allowlist: low-risk params that developers may toggle during
// debugging. Everything not listed here is deny (fail closed).
// Ceiling is ask — can never be widened to allow (SR2 §2.1).
//
// Selection criteria (consistent with device path / port / endpoint allowlists):
// - Only debugging/UI parameters with reversible, low-impact effects
// - No system boot, security, USB, or kernel-bridging parameters
// - Prefix-based matching, same as device path allowlist
const PARAM_ALLOWLIST: readonly (string | RegExp)[] = [
  "persist.sys.hilog.",
  "debug.",
  "persist.ace.darkmode",
  "persist.sys.font_scale",
  "persist.sys.font_wght_scale",
]

export function validateParamName(paramName: string): ValidationResult {
  // Read-only prefixes: deny (no point asking user to confirm a no-op)
  if (READONLY_PARAM_PREFIXES.some((prefix) => paramName.startsWith(prefix))) {
    return {
      _tag: "invalid",
      reasonCode: "param_readonly",
      detail: `param ${paramName} is read-only (prefix denied)`,
    }
  }

  // Allowlist: valid → goes to ask via productDefault
  const matched = PARAM_ALLOWLIST.some((entry) => {
    if (typeof entry === "string") return paramName.startsWith(entry)
    return entry.test(paramName)
  })
  if (!matched) {
    return {
      _tag: "invalid",
      reasonCode: "param_not_allowed",
      detail: `param ${paramName} is not in allowlist`,
    }
  }

  return { _tag: "valid" }
}

// ─── Bundle validators ─────────────────────────────────────

// Fail closed: a bundle must be one of the current project's bundles
// (FR-OBJECT-002 / AR-SEC2-002 §2). An empty project list is not a
// valid "install anything" loophole — treat it as unknown and deny.
export function validateBundle(
  bundleName: string | undefined,
  ctx: ValidationContext,
): ValidationResult {
  if (!bundleName) {
    return {
      _tag: "invalid",
      reasonCode: "bundle_not_allowed",
      detail: "bundle name is required but not provided",
    }
  }

  // System bundle uninstall is handled by isHardDeny in Step 3 (product hard deny).
  // If a system bundle reaches here, it means isHardDeny didn't catch it —
  // this is a defensive check that should not normally trigger.
  if (!ctx.projectBundles.includes(bundleName)) {
    return {
      _tag: "invalid",
      reasonCode: "bundle_not_allowed",
      detail: `bundle ${bundleName} is not in current project bundle list`,
    }
  }

  return { _tag: "valid" }
}

// ─── Target device validators ──────────────────────────────

export function validateTargetDevice(
  operation: HdcOperation,
  ctx: ValidationContext,
): ValidationResult {
  const target = ctx.targetDevice

  if (operation.kind === "versionOrHelp") {
    if (target.selection !== "not_applicable") {
      return {
        _tag: "invalid",
        reasonCode: "invalid_request",
        detail: "non-device operation must not have a target device",
      }
    }
    return { _tag: "valid" }
  }

  const needsDevice = !isNonDeviceOperation(operation)
  if (needsDevice && target.selection === "not_applicable") {
    return {
      _tag: "invalid",
      reasonCode: "target_device_ambiguous",
      detail: "operation requires a target device but none is available",
    }
  }

  if (needsDevice && target.selection === "raw") {
    return {
      _tag: "invalid",
      reasonCode: "target_device_ambiguous",
      detail: "target device selection is ambiguous",
    }
  }

  return { _tag: "valid" }
}

// ─── Operation-level validation ────────────────────────────

export function validateOperation(
  operation: HdcOperation,
  request: { cwd: string },
  trustedContext: HdcGuardTrustedContext,
): ValidationResult {
  const ctx: ValidationContext = {
    cwd: request.cwd,
    workspaceRoot: trustedContext.workspaceRoot,
    targetDevice: trustedContext.targetDevice,
    projectBundles: trustedContext.projectBundles,
  }
  const targetResult = validateTargetDevice(operation, ctx)
  if (targetResult._tag === "invalid") return targetResult

  switch (operation.kind) {
    case "install": {
      const localResult = validateLocalInput(operation.packagePath, ctx)
      if (localResult._tag === "invalid") return localResult
      // Application identity of the package must match the current project
      // (FR-OBJECT-002). Read the hap's bundleName directly; fail closed
      // when it cannot be determined.
      return validateBundle(readHapBundleName(resolveLocalPath(operation.packagePath, request.cwd)), ctx)
    }
    case "fileSend": {
      const localResult = validateLocalInput(operation.localPath, ctx)
      if (localResult._tag === "invalid") return localResult
      return validateDevicePath(operation.remotePath)
    }
    case "fileRecv": {
      const localResult = validateLocalOutput(operation.localPath, ctx)
      if (localResult._tag === "invalid") return localResult
      return validateDevicePath(operation.remotePath)
    }
    case "uninstall": {
      return validateBundle(operation.bundleName, ctx)
    }
    case "appControl": {
      if (operation.action.startsWith("aa ")) {
        return validateBundle(operation.bundleName, ctx)
      }
      return { _tag: "valid" }
    }
    case "transportConnect": {
      return validateEndpoint(operation.endpoint)
    }
    case "portForward": {
      // hdc fport/rport uses format: tcp:localPort:remotePort (e.g. tcp:8080:8080)
      // Also supports bare numeric args for older formats.
      const ports: number[] = []
      for (const arg of operation.args) {
        if (/^\d+$/.test(arg)) {
          ports.push(parseInt(arg, 10))
        } else {
          // Extract all port numbers from tcp:localPort:remotePort format
          const matches = arg.match(/:(\d+)/g)
          if (matches) {
            for (const m of matches) {
              ports.push(parseInt(m.slice(1), 10))
            }
          }
        }
      }
      for (const port of ports) {
        const portResult = validatePort(port)
        if (portResult._tag === "invalid") return portResult
      }
      return { _tag: "valid" }
    }
    case "shell": {
      const deviceArgv = operation.deviceArgv
      if (deviceArgv.length === 0) return { _tag: "valid" }

      if (deviceArgv[0] === "rm" || deviceArgv[0] === "mkdir" || deviceArgv[0] === "rmdir") {
        // Every non-flag argument is a device path
        for (const arg of deviceArgv.slice(1)) {
          if (arg.startsWith("-")) continue
          const pathResult = validateDevicePath(arg)
          if (pathResult._tag === "invalid") return pathResult
        }
      }

      if (deviceArgv[0] === "chmod" || deviceArgv[0] === "chown") {
        // First non-flag argument is the mode/owner spec, the rest are device paths.
        // Treating the mode ("644") as a path used to misfire device_path_denied (L2).
        const operands = deviceArgv.slice(1).filter((a) => !a.startsWith("-"))
        for (const arg of operands.slice(1)) {
          const pathResult = validateDevicePath(arg)
          if (pathResult._tag === "invalid") return pathResult
        }
      }

      // param set <name> <value>: validate the param name against allowlist
      if (deviceArgv[0] === "param" && deviceArgv[1] === "set" && deviceArgv[2]) {
        return validateParamName(deviceArgv[2])
      }

      return { _tag: "valid" }
    }
    default:
      return { _tag: "valid" }
  }
}

// ─── Helpers ───────────────────────────────────────────────

function resolveLocalPath(inputPath: string, cwd: string): string {
  if (path.isAbsolute(inputPath)) return path.normalize(inputPath)
  return path.normalize(path.join(cwd, inputPath))
}

function isWithinWorkspace(filePath: string, workspaceRoot: string): boolean {
  const normalized = filePath.replace(/\\/g, "/")
  const root = workspaceRoot.replace(/\\/g, "/")
  return normalized === root || normalized.startsWith(root + "/")
}

function isNonDeviceOperation(op: HdcOperation): boolean {
  return op.kind === "versionOrHelp" || op.kind === "listTargets" || op.kind === "discover"
}
