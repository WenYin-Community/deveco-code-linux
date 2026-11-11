import { Config } from "effect"

export function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

const DEVECO_EXPERIMENTAL = truthy("DEVECO_EXPERIMENTAL")
const copy = process.env["DEVECO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
const fff = process.env["DEVECO_DISABLE_FFF"]

function enabledByExperimental(key: string) {
  return process.env[key] === undefined ? DEVECO_EXPERIMENTAL : truthy(key)
}

// Default-on experimental flag: enabled unless the dedicated env var is
// explicitly set to a non-truthy value; DEVECO_EXPERIMENTAL=true keeps forcing
// it on. Mirrors enabledByDefault in packages/opencode runtime-flags.ts.
function enabledByDefault(key: string) {
  return process.env[key] === undefined ? true : DEVECO_EXPERIMENTAL || truthy(key)
}

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  DEVECO_AUTO_HEAP_SNAPSHOT: truthy("DEVECO_AUTO_HEAP_SNAPSHOT"),
  DEVECO_GIT_BASH_PATH: process.env["DEVECO_GIT_BASH_PATH"],
  DEVECO_CONFIG: process.env["DEVECO_CONFIG"],
  DEVECO_CONFIG_CONTENT: process.env["DEVECO_CONFIG_CONTENT"],
  DEVECO_DISABLE_AUTOUPDATE: truthy("DEVECO_DISABLE_AUTOUPDATE"),
  DEVECO_ALWAYS_NOTIFY_UPDATE: truthy("DEVECO_ALWAYS_NOTIFY_UPDATE"),
  DEVECO_DISABLE_PRUNE: truthy("DEVECO_DISABLE_PRUNE"),
  DEVECO_DISABLE_TERMINAL_TITLE: truthy("DEVECO_DISABLE_TERMINAL_TITLE"),
  DEVECO_SHOW_TTFD: truthy("DEVECO_SHOW_TTFD"),
  DEVECO_DISABLE_AUTOCOMPACT: truthy("DEVECO_DISABLE_AUTOCOMPACT"),
  DEVECO_DISABLE_MODELS_FETCH: truthy("DEVECO_DISABLE_MODELS_FETCH"),
  DEVECO_DISABLE_MOUSE: truthy("DEVECO_DISABLE_MOUSE"),
  DEVECO_FAKE_VCS: process.env["DEVECO_FAKE_VCS"],
  DEVECO_SERVER_PASSWORD: process.env["DEVECO_SERVER_PASSWORD"],
  DEVECO_SERVER_USERNAME: process.env["DEVECO_SERVER_USERNAME"],
  DEVECO_DISABLE_FFF: fff === undefined ? process.platform === "win32" : truthy("DEVECO_DISABLE_FFF"),

  // Experimental
  DEVECO_EXPERIMENTAL,
  DEVECO_EXPERIMENTAL_FILEWATCHER: Config.boolean("DEVECO_EXPERIMENTAL_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  DEVECO_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.boolean("DEVECO_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  DEVECO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("DEVECO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  DEVECO_MODELS_URL: process.env["DEVECO_MODELS_URL"],
  DEVECO_MODELS_PATH: process.env["DEVECO_MODELS_PATH"],
  DEVECO_DB: process.env["DEVECO_DB"],

  DEVECO_WORKSPACE_ID: process.env["DEVECO_WORKSPACE_ID"],
  DEVECO_EXPERIMENTAL_WORKSPACES: enabledByDefault("DEVECO_EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get DEVECO_DISABLE_PROJECT_CONFIG() {
    return truthy("DEVECO_DISABLE_PROJECT_CONFIG")
  },
  get DEVECO_EXPERIMENTAL_REFERENCES() {
    return enabledByExperimental("DEVECO_EXPERIMENTAL_REFERENCES")
  },
  get DEVECO_TUI_CONFIG() {
    return process.env["DEVECO_TUI_CONFIG"]
  },
  get DEVECO_CONFIG_DIR() {
    return process.env["DEVECO_CONFIG_DIR"]
  },
  get DEVECO_PURE() {
    return truthy("DEVECO_PURE")
  },
  get DEVECO_PERMISSION() {
    return process.env["DEVECO_PERMISSION"]
  },
  get DEVECO_PLUGIN_META_FILE() {
    return process.env["DEVECO_PLUGIN_META_FILE"]
  },
  get DEVECO_DISABLE_CREDENTIAL_KEYCHAIN() {
    return truthy("DEVECO_DISABLE_CREDENTIAL_KEYCHAIN")
  },
  get DEVECO_DISABLE_MEMORY() {
    return truthy("DEVECO_DISABLE_MEMORY")
  },
  get DEVECO_CLIENT() {
    return process.env["DEVECO_CLIENT"] ?? "cli"
  },
  /**
   * Kill-switch for TMS signing in plugin mode.
   *
   * Dual-check design: alwaysAcceptAgreement() requires both
   * Runtime.current.mode === "deveco-studio" AND this flag.
   * This prevents silent fallback to the old deadlock behavior if the plugin
   * forgets to set the flag — the mode check alone would not catch that bug.
   * If DEVECO_RUNTIME_MODE is unset or not "deveco-studio", this flag is ignored.
   */
  get DEVECO_ALWAYS_ACCEPT_AGREEMENT() {
    return truthy("DEVECO_ALWAYS_ACCEPT_AGREEMENT")
  },
}
