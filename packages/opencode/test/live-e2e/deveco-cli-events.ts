import fs from "node:fs/promises"

export function partOf(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const part = event.part
  if (!part || typeof part !== "object") return undefined
  return part as Record<string, unknown>
}

export function parseEvents(stdout: string) {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>]
      } catch {
        return []
      }
    })
}

export function textFromEvents(events: Record<string, unknown>[]) {
  return events
    .filter((event) => event.type === "text")
    .flatMap((event) => {
      const part = partOf(event)
      return typeof part?.text === "string" ? [part.text] : []
    })
    .join("\n")
}

export function sessionIDFromEvents(events: Record<string, unknown>[]) {
  const sessionID = events.find((event) => typeof event.sessionID === "string")?.sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

export function devecoCliToolEvents(events: Record<string, unknown>[], command: "build" | "create") {
  const pattern = new RegExp(`(?:^|\\s)devecocli\\s+${command}(?:\\s|$)`)
  return events.filter((event) => {
    if (event.type !== "tool_use") return false
    const part = partOf(event)
    if (part?.tool !== "bash") return false
    const state = part.state as Record<string, unknown> | undefined
    const input = state?.input as Record<string, unknown> | undefined
    return typeof input?.command === "string" && pattern.test(input.command)
  })
}

export function completedDevecoCliEvent(events: Record<string, unknown>[], command: "build" | "create") {
  return devecoCliToolEvents(events, command).find((event) => {
    const state = partOf(event)?.state as Record<string, unknown> | undefined
    return state?.status === "completed"
  })
}

export function createEventDetails(event: Record<string, unknown>) {
  const state = partOf(event)?.state as Record<string, unknown> | undefined
  const input = state?.input as Record<string, unknown> | undefined
  const command = typeof input?.command === "string" ? input.command : ""
  const output = typeof state?.output === "string" ? state.output : ""
  const projectRoot = output.match(/Project root:\s*(.+)/)?.[1]?.trim()
  if (!projectRoot) throw new Error(`devecocli create output is missing Project root:\n${output}`)
  return { command, output, projectRoot }
}

export async function requireRegularFile(file: string) {
  const stat = await fs.stat(file).catch((error) => {
    throw new Error(`${file} was not found: ${error instanceof Error ? error.message : String(error)}`)
  })
  if (!stat.isFile()) throw new Error(`${file} is not a regular file`)
}
