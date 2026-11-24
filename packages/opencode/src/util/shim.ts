import { existsSync } from "node:fs"
import path from "node:path"

export function isolatedShellPath(current: string | undefined, shimDir: string) {
  const normalize = (dir: string) => {
    const resolved = path.resolve(dir)
    return process.platform === "win32" ? resolved.toLowerCase() : resolved
  }
  // Keep the remaining directories: they may supply node or other host shims.
  const filtered = [shimDir]
  const seen = new Set([normalize(shimDir)])
  for (const part of (current ?? "").split(path.delimiter).filter(Boolean)) {
    const key = normalize(part)
    if (seen.has(key)) continue
    seen.add(key)
    filtered.push(part)
  }
  return filtered.join(path.delimiter)
}

export function resolveShimLauncher(entry: string, main = Bun.main, executable = process.execPath) {
  // Compiled executables dispatch shim commands themselves; bunfs has no source entry.
  if (main.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]root[\\/]/i.test(main)) return [executable]
  // Source runs must re-enter a dedicated script, rather than a TUI worker or JSX entry.
  if (existsSync(entry) && /\.[cm]?[jt]s$/i.test(entry)) {
    return [executable, "run", "--conditions=browser", entry]
  }
  if (existsSync(main) && /\.[cm]?[jt]s$/i.test(main)) {
    return [executable, "run", "--conditions=browser", main]
  }
  return [executable]
}
