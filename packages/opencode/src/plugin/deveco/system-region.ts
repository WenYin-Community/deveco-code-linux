import { execFile } from "child_process"
import { promisify } from "util"

const execFileAsync = promisify(execFile)

export async function readSystemRegion(): Promise<string> {
  try {
    if (process.platform === "darwin") return await readMacSystemRegion()
    if (process.platform === "win32") return await readWindowsSystemRegion()
    return ""
  } catch {
    return ""
  }
}

async function readMacSystemRegion(): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/defaults", ["read", "-g", "AppleLocale"], {
    encoding: "utf8",
    timeout: 2_000,
  })

  return regionFromLocale(stdout)
}

function regionFromLocale(value: string): string {
  try {
    const locale = value.trim().split("@")[0].replaceAll("_", "-")
    return new Intl.Locale(locale).region?.toUpperCase() ?? ""
  } catch {
    return ""
  }
}

async function readWindowsSystemRegion(): Promise<string> {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows"
  const powershell = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`

  const command =
    "[Windows.System.UserProfile.GlobalizationPreferences," +
    "Windows.System.UserProfile,ContentType=WindowsRuntime]" +
    "::HomeGeographicRegion"

  const { stdout } = await execFileAsync(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    {
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
    },
  )

  return stdout.trim().toUpperCase()
}
