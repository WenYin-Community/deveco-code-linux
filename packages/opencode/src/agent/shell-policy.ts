// Host invocation policy: documentation previews and long-running tool downloads.
export const DOCS_PREVIEW_CHARS_ENV = "DEVECO_DOCS_PREVIEW_CHARS"
export const ASK_DOCS_PREVIEW_CHARS = 20_000

export const DEVECO_IMAGE_DOWNLOAD_TIMEOUT_MS = 2 * 60 * 60 * 1000
const DEVECO_IMAGE_DOWNLOAD_COMMAND = new RegExp(
  "\\bdevecocli(?:\\.(?:cmd|exe))?\\s+emulator\\s+image\\s+download\\b",
  "i",
)
const SHELL_COMMAND_QUOTES = new RegExp("[\"']", "g")
const SHELL_COMMAND_WHITESPACE = new RegExp("\\s+", "g")

export function resolveShellTimeout(command: string, timeout: number): number {
  const normalized = command.replace(SHELL_COMMAND_QUOTES, " ").replace(SHELL_COMMAND_WHITESPACE, " ")
  return DEVECO_IMAGE_DOWNLOAD_COMMAND.test(normalized) ? Math.max(timeout, DEVECO_IMAGE_DOWNLOAD_TIMEOUT_MS) : timeout
}
