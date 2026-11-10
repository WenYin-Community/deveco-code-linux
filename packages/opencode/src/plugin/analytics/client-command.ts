import { devecoAuth } from "../deveco"
import { globalCollector } from "./collector"
import { createEnvironmentFields } from "./events"
import { getOrCreateProjectId, usableProjectDirectory } from "./project-id"
import { getVersion } from "./storage"
import { ANALYTICS_ACTION, SLASH_COMMAND_NAME_MAX_LENGTH } from "./types"
import type { AnalyticsSubmission, DevEcoCodeSlashEvent } from "./types"
import { globalUploader } from "./uploader"

// Session IDs are opaque client-supplied strings; bound them so a misbehaving client cannot write
// unbounded data into the queue.
const SESSION_ID_MAX_LENGTH = 128

export interface ClientCommandInput {
  // Command name without the leading slash. Clients pass the palette/slash name.
  name: string
  // Session the command was executed from, when the client knows one.
  sessionID?: string
  // Directory of the project the command ran in; ignored unless it is an existing absolute
  // directory, in which case projectId resolves against it (otherwise the server cwd is used).
  directory?: string
}

interface ClientCommandUploader {
  upload(submission: AnalyticsSubmission): Promise<boolean>
  flush(): Promise<unknown>
}

export interface ClientCommandDependencies {
  isLoggedIn(): Promise<boolean>
  isJwtExpired(): Promise<boolean | null>
  analyticsEnabled(): Promise<boolean>
  projectId(directory: string): Promise<string>
  uploader: ClientCommandUploader
  version(): string
}

function boundedSessionID(candidate: string | undefined): string {
  const value = candidate?.trim().slice(0, SESSION_ID_MAX_LENGTH)
  return value ? value : "unknown"
}

// Reports a slash command a client (the TUI) executed locally, without going through
// SessionPrompt.command. Server-dispatched commands are reported by analytics-plugin instead;
// both paths write the same event shape, which carries the command name and nothing else.
export function createClientCommandRecorder(dependencies: ClientCommandDependencies) {
  return async function recordClientCommand(input: ClientCommandInput): Promise<void> {
    try {
      const commandName = input.name.trim().slice(0, SLASH_COMMAND_NAME_MAX_LENGTH)
      // The queue validator rejects empty names, so such an event would be silently dropped on
      // the next queue read; skip it before enqueueing anything.
      if (!commandName) return
      // Same identity gate as the server hook: the command hook also rejects expired JWTs, and a
      // client report must not be accepted on a different eligibility rule.
      if (!(await dependencies.isLoggedIn())) return
      if ((await dependencies.isJwtExpired()) === true) return
      if (!(await dependencies.analyticsEnabled())) return
      const directory = (await usableProjectDirectory(input.directory)) ?? process.cwd()
      const event: DevEcoCodeSlashEvent = {
        ...createEnvironmentFields(dependencies.version()),
        timestamp: Date.now(),
        sessionid: boundedSessionID(input.sessionID),
        projectId: await dependencies.projectId(directory),
        commandName,
      }
      // upload() is an awaited local encrypted queue write; the network flush is fire-and-forget
      // so a slow upload can never delay the command that triggered the report.
      await dependencies.uploader.upload({ action: ANALYTICS_ACTION.SLASH_COMMAND, event })
      void dependencies.uploader.flush().catch(() => undefined)
    } catch {
      // Analytics must never fail or delay the client command that triggered the report.
    }
  }
}

export const recordClientCommand = createClientCommandRecorder({
  isLoggedIn: () => devecoAuth.isLoggedIn(),
  isJwtExpired: () => devecoAuth.isJwtExpired(),
  analyticsEnabled: () => globalCollector.analyticsEnabled(),
  projectId: getOrCreateProjectId,
  uploader: globalUploader,
  version: getVersion,
})
