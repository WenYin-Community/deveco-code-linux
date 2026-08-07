import path from "path"
import { PS_ENCODING_PREAMBLE } from "@opencode-ai/core/shell"
import * as Process from "./process"

export async function extractZip(zipPath: string, destDir: string) {
  if (process.platform === "win32") {
    const winZipPath = path.resolve(zipPath)
    const winDestDir = path.resolve(destDir)
    // $global:ProgressPreference suppresses PowerShell's blue progress bar popup
    // Escape single quotes in paths (PowerShell single-quote string escape: ' -> '')
    // Use -LiteralPath to prevent wildcard expansion, matching ripgrep/binary.ts pattern
    const cmd = `${PS_ENCODING_PREAMBLE}$global:ProgressPreference = 'SilentlyContinue'; Expand-Archive -LiteralPath '${winZipPath.replaceAll("'", "''")}' -DestinationPath '${winDestDir.replaceAll("'", "''")}' -Force`
    await Process.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd])
    return
  }

  await Process.run(["unzip", "-o", "-q", zipPath, "-d", destDir])
}

export * as Archive from "./archive"
