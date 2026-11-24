import path from "node:path"
import { resolveShimLauncher } from "@/util/shim"

export function resolveHdcShimLauncher(main = Bun.main, executable = process.execPath) {
  return resolveShimLauncher(path.join(import.meta.dirname, "proxy.ts"), main, executable)
}
