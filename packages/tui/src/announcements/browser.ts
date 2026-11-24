import { dlopen, ptr } from "bun:ffi"
import { spawn } from "node:child_process"

const loadWindowsShell = () =>
  dlopen("shell32.dll", {
    ShellExecuteW: { args: ["ptr", "ptr", "ptr", "ptr", "ptr", "i32"], returns: "ptr" },
  })
let windowsShell: ReturnType<typeof loadWindowsShell> | undefined

export const AnnouncementBrowser = {
  async open(href: string): Promise<boolean> {
    if (process.platform === "win32") {
      windowsShell ??= loadWindowsShell()
      const url = Buffer.from(`${href}\0`, "utf16le")
      // Use the registered protocol handler directly, without a shell or console process.
      const result = windowsShell.symbols.ShellExecuteW(null, null, ptr(url), null, null, 1)
      return (result ?? 0) > 32
    }

    return new Promise((resolve) => {
      const processHandle = spawn(process.platform === "darwin" ? "open" : "xdg-open", [href], {
        detached: true,
        stdio: "ignore",
      })
      processHandle.once("error", () => resolve(false))
      processHandle.once("exit", (code) => resolve(code === 0))
      processHandle.unref()
    })
  },
}
