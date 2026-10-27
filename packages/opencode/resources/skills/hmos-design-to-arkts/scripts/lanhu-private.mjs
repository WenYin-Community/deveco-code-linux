import fs from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

export async function safeManagedPath(file) {
  const target = path.resolve(file)
  const info = await fs.lstat(target).catch((error) => {
    if (error.code !== "ENOENT") throw error
  })
  if (info?.isSymbolicLink()) throw new Error("Managed Lanhu paths must not contain symlinks")
  if (path.dirname(target) !== target) await safeManagedPath(path.dirname(target))
  return target
}

export async function protectPrivatePath(file, directory = false) {
  await safeManagedPath(file)
  if (directory) await fs.mkdir(file, { recursive: true, mode: 0o700 })
  if (process.platform !== "win32") {
    await fs.chmod(file, directory ? 0o700 : 0o600)
    return
  }
  // Set an explicit current-user ACL; chmod does not restrict Windows readers.
  // icacls rewrites only the DACL, which an unprivileged owner may always write.
  // Set-Acl round-trips the whole descriptor and fails with a missing
  // SeSecurityPrivilege on descriptors that carry audit rules.
  const sid = await currentUserId()
  await promisify(execFile)(
    "icacls.exe",
    // Keep "/grant:r" and the ACE spec as separate arguments: icacls on
    // Windows 11 24H2+ (build 26100) rejects the combined "/grant:r:Sid:perm"
    // form with error 87; the documented syntax is space-separated.
    [file, "/inheritance:r", "/grant:r", `*${sid}:${directory ? "(OI)(CI)F" : "F"}`],
    {
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 16_384,
    },
  ).catch((error) => {
    const detail = [String(error.stderr ?? ""), String(error.stdout ?? "")]
      .filter(Boolean)
      .join(" ")
      .trim()
    throw new Error(
      `Unable to restrict the Windows Lanhu credential ACL: ${detail || error.message}`,
    )
  })
}

async function currentUserId() {
  const { stdout } = await promisify(execFile)("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
    windowsHide: true,
    timeout: 15_000,
  })
  const sid = stdout
    .trim()
    .split("\n")
    .at(-1)
    ?.split(",")
    .at(-1)
    ?.replaceAll('"', "")
    .trim()
  if (!sid?.startsWith("S-1-")) throw new Error("Unable to resolve the current Windows user SID")
  return sid
}
