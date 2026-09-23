import path from "path"

export type Mode = "default" | "deveco-studio"
export type AgentProfile = "default" | "deveco-studio"
export type AnalyticsSourceType = "DevEco-Code-Cli" | "DevEco-Code-Plugin"

export interface AnalyticsSource {
  readonly sourceType: AnalyticsSourceType
  readonly sourceVersion?: string
}

const CLI_SOURCE_TYPE = "DevEco-Code-Cli" as const
const STUDIO_SOURCE_TYPE = "DevEco-Code-Plugin" as const
const MAX_SOURCE_VERSION_LENGTH = 256

export interface Info {
  readonly mode: Mode
  readonly storageRoot?: string
  readonly agentProfile: AgentProfile
  readonly analyticsSource: AnalyticsSource
  readonly configSources: {
    readonly project: boolean
    readonly home: boolean
    readonly explicit: boolean
    readonly projectInstructions: boolean
    readonly homeClaudeInstructions: boolean
  }
}

function defaultInfo(): Info {
  return {
    mode: "default",
    agentProfile: "default",
    analyticsSource: {
      sourceType: CLI_SOURCE_TYPE,
    },
    configSources: {
      project: true,
      home: true,
      explicit: true,
      projectInstructions: true,
      homeClaudeInstructions: true,
    },
  }
}

export function resolve(env: Record<string, string | undefined>): Info {
  const value = env.DEVECO_RUNTIME_MODE?.trim()
  const mode = value === undefined || value === "" ? "default" : value
  if (mode !== "default" && mode !== "deveco-studio") {
    throw new Error(`Unsupported DEVECO_RUNTIME_MODE: ${mode}`)
  }
  if (mode === "default") {
    return defaultInfo()
  }

  const storageRoot = env.DEVECO_STORAGE_ROOT?.trim()
  if (!storageRoot) throw new Error("DEVECO_STORAGE_ROOT is required when DEVECO_RUNTIME_MODE=deveco-studio")
  if (!path.isAbsolute(storageRoot)) {
    throw new Error("DEVECO_STORAGE_ROOT must be an absolute path when DEVECO_RUNTIME_MODE=deveco-studio")
  }

  const requestedSourceType = env.DEVECO_SOURCE_TYPE?.trim()
  if (requestedSourceType && requestedSourceType !== STUDIO_SOURCE_TYPE) {
    throw new Error(`Unsupported DEVECO_SOURCE_TYPE for deveco-studio mode: ${requestedSourceType}`)
  }

  const requestedSourceVersion = env.DEVECO_SOURCE_VERSION?.trim()
  const sourceVersion =
    requestedSourceVersion &&
    requestedSourceVersion.length <= MAX_SOURCE_VERSION_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(requestedSourceVersion)
      ? requestedSourceVersion
      : "unknown"

  return {
    mode,
    storageRoot: path.normalize(storageRoot),
    agentProfile: "deveco-studio",
    analyticsSource: {
      sourceType: STUDIO_SOURCE_TYPE,
      sourceVersion,
    },
    configSources: {
      project: false,
      home: false,
      explicit: false,
      projectInstructions: true,
      homeClaudeInstructions: false,
    },
  }
}

export const current = resolve(process.env)

export function getAnalyticsSource(defaultSourceVersion: string): Required<AnalyticsSource> {
  return {
    sourceType: current.analyticsSource.sourceType,
    sourceVersion: current.analyticsSource.sourceVersion ?? defaultSourceVersion,
  }
}

export * as Runtime from "./runtime"
