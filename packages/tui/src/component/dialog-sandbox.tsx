import { RGBA, TextAttributes } from "@opentui/core"
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { Effect } from "effect"
import { modify, applyEdits, parse, type ParseError } from "jsonc-parser"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { useBindings } from "../keymap"
import { useTuiConfig } from "../config"
import { useI18n } from "../i18n"
import { SandboxResolver } from "@opencode-ai/core/config/sandbox-resolver"
import { type SandboxConfig as CoreSandboxConfig, validateSandboxShape as validateSandboxConfigShape, BUILTIN_PROFILES } from "@opencode-ai/core/config/sandbox"
import { setRuntimeSandbox, getRuntimeSandbox } from "@opencode-ai/core/config/runtime-sandbox"
import { useProject } from "../context/project"
import { setCurrentSandboxProfile } from "../context/sandbox-profile"

// /sandbox dialog — tabbed UI (Mode / Custom)
// Mode tab: built-in profiles + write status + status summary
// Custom tab: user profiles + config validation errors

const SANDBOX_TABS = ["mode", "custom"] as const
type SandboxTab = (typeof SANDBOX_TABS)[number]

const TAB_KEYS: Record<SandboxTab, string> = {
  mode: "dialog.sandbox.tab_mode",
  custom: "dialog.sandbox.tab_custom",
}

const TAB_BG = RGBA.fromHex("#AFD7FF")
const TAB_FG = RGBA.fromHex("#000000")

function wrapPrev<T>(list: readonly T[], current: T) {
  const index = list.indexOf(current)
  if (index === -1) return current
  return list[(index - 1 + list.length) % list.length] ?? current
}

function wrapNext<T>(list: readonly T[], current: T) {
  const index = list.indexOf(current)
  if (index === -1) return current
  return list[(index + 1) % list.length] ?? current
}

// Display name for a profile id. Built-in profiles use Title Case to match
// the option list and other dialogs. Custom profile ids are shown as-is.
export function profileDisplayName(profileId: string): string {
  const builtin: Record<string, string> = {
    "read-only": "Read-only",
    "workspace": "Workspace",
    "full-access": "Full-access",
  }
  return builtin[profileId] ?? profileId
}

export function windowsProfileValidationError(
  config: CoreSandboxConfig,
  profileId: string,
  runtime?: CoreSandboxConfig,
) {
  const layers: SandboxResolver.LayeredSandboxConfig = {
    global: config,
    runtime: { ...runtime, profile: profileId },
  }
  return Effect.runSync(
    SandboxResolver.resolveSandbox(layers).pipe(
      Effect.flatMap((resolved) => SandboxResolver.validateWindowsProfile(layers, resolved)),
      Effect.match({
        onFailure: (error) => error,
        onSuccess: () => undefined,
      }),
    ),
  )
}

// Sandbox config shape (mirrors ConfigSandbox.SandboxConfig)
interface SandboxProfileDef {
  description?: string
  extends?: string
  workspace_roots?: string[]
  filesystem?: Record<string, string>
  network?: { enabled: boolean }
}

interface SandboxConfig {
  profile?: string
  profiles?: Record<string, SandboxProfileDef>
  allowed_profiles?: string[]
  network?: { enabled: boolean }
}

function useSandboxSnapshot() {
  const sync = useSync()
  const config = sync.data.config as unknown as { sandbox?: SandboxConfig }
  const value = config?.sandbox
  return () => value
}

function findGlobalConfigFile(): string {
  const configDir = Global.Path.config
  const candidates = ["config.json", "deveco.json", "deveco.jsonc"]
  for (const name of candidates) {
    const filepath = path.join(configDir, name)
    if (existsSync(filepath)) return filepath
  }
  return path.join(configDir, "deveco.jsonc")
}

// Check if the project-level config file defines a sandbox.profile.
// Matches shell.ts findProjectConfig: checks both <dir>/<name> and <dir>/.deveco/<name>,
// and walks up ancestor directories to the filesystem root.
// Returns profile id and file path if found.
async function readProjectSandboxProfile(projectDir: string | undefined): Promise<{ profile: string; filepath: string } | undefined> {
  if (!projectDir) return undefined
  const names = ["config.json", "deveco.json", "deveco.jsonc"]
  let dir = projectDir
  while (dir !== path.dirname(dir)) {
    const found = await findSandboxInDir(dir, names)
    if (found) return found
    dir = path.dirname(dir)
  }
  return undefined
}

async function findSandboxInDir(
  dir: string,
  names: string[],
): Promise<{ profile: string; filepath: string } | undefined> {
  for (const prefix of ["", ".deveco"]) {
    for (const name of names) {
      const found = await tryReadSandboxProfile(path.join(dir, prefix, name))
      if (found) return found
    }
  }
  return undefined
}

async function tryReadSandboxProfile(filepath: string): Promise<{ profile: string; filepath: string } | undefined> {
  try {
    const text = await readFile(filepath, "utf-8")
    const errors: ParseError[] = []
    const parsed = parse(text, errors, { allowTrailingComma: true }) as { sandbox?: SandboxConfig } | undefined
    if (errors.length === 0 && parsed?.sandbox?.profile) {
      return { profile: parsed.sandbox.profile, filepath }
    }
  } catch {
    // file doesn't exist or unreadable
  }
  return undefined
}

// Check if the global config file defines a sandbox.profile.
async function readGlobalSandboxProfile(): Promise<string | undefined> {
  const filepath = findGlobalConfigFile()
  try {
    const text = await readFile(filepath, "utf-8")
    const errors: ParseError[] = []
    const parsed = parse(text, errors, { allowTrailingComma: true }) as { sandbox?: SandboxConfig } | undefined
    if (errors.length === 0 && parsed?.sandbox?.profile) {
      return parsed.sandbox.profile
    }
  } catch {
    // file doesn't exist
  }
  return undefined
}

async function writeSandboxProfile(profileId: string): Promise<string> {
  const filepath = findGlobalConfigFile()
  let text = ""
  try {
    text = await readFile(filepath, "utf-8")
  } catch {
    text = "{}"
  }

  const edits = modify(text, ["sandbox", "profile"], profileId, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  })
  const newText = applyEdits(text, edits)

  const errors: ParseError[] = []
  const parsed = parse(newText, errors, { allowTrailingComma: true })
  if (errors.length > 0) {
    throw new Error("Resulting JSON is invalid")
  }
  if (parsed?.sandbox?.profile !== profileId) {
    throw new Error("Profile not set correctly after write")
  }

  const tmpPath = `${filepath}.${process.pid}.${Date.now()}.tmp`
  await mkdir(path.dirname(filepath), { recursive: true })
  await writeFile(tmpPath, newText, "utf-8")
  try {
    const { rename } = await import("node:fs/promises")
    await rename(tmpPath, filepath)
  } catch {
    await writeFile(filepath, newText, "utf-8")
  }

  return filepath
}

export function DialogSandbox() {
  const { t } = useI18n()
  const dialog = useDialog()
  const { theme } = useTheme()
  const sync = useSync()
  const tuiConfig = useTuiConfig()
  const snapshot = useSandboxSnapshot()
  const project = useProject()

  const [activeTab, setActiveTab] = createSignal<SandboxTab>("mode")

  const sandboxConfig = createMemo(() => snapshot())

  // Runtime override (session-level, S-SESS-1). Read from the shared file
  // so the TUI process sees what the server process wrote.
  // Sources: session override file > DEVECO_CONFIG_CONTENT > DEVECO_CONFIG
  const [runtimeOverride, setRuntimeOverride] = createSignal<CoreSandboxConfig | undefined>(undefined)
  // Config-source detection: which layer provided the active profile?
  const [configSource, setConfigSource] = createSignal<"runtime" | "project" | "global" | "default">("default")

  const refreshRuntimeOverride = () =>
    getRuntimeSandbox().then(setRuntimeOverride).catch(() => setRuntimeOverride(undefined))
  void refreshRuntimeOverride()

  // Detect whether the active profile comes from the project or global config file.
  // The sync.data.config is a merge of both, so we check the files directly.
  const [projectOverride, setProjectOverride] = createSignal<{ profile: string; filepath: string } | undefined>(undefined)
  const refreshConfigSource = async () => {
    const projectDir = project.instance.directory()
    const projectResult = await readProjectSandboxProfile(projectDir)
    if (projectResult) {
      setConfigSource("project")
      setProjectOverride(projectResult)
      return undefined
    }
    setProjectOverride(undefined)
    const globalProfile = await readGlobalSandboxProfile()
    if (globalProfile) {
      setConfigSource("global")
      return undefined
    }
    setConfigSource("default")
  }
  void refreshConfigSource()

  const effectiveProfile = createMemo(() => {
    const rt = runtimeOverride()
    // Priority: runtime override (session/env) > config layers > default
    if (rt?.profile) {
      return {
        id: rt.profile,
        isImplicit: false,
        sourceLabel: t("dialog.sandbox.config_source_runtime"),
      }
    }
    // Check env vars that inject the runtime layer
    if (process.env.DEVECO_CONFIG_CONTENT || process.env.DEVECO_CONFIG) {
      return {
        id: sandboxConfig()?.profile ?? "full-access",
        isImplicit: false,
        sourceLabel: t("dialog.sandbox.config_source_runtime"),
      }
    }
    const cfg = sandboxConfig()
    if (!cfg || !cfg.profile) {
      return { id: "workspace", isImplicit: true, sourceLabel: t("dialog.sandbox.config_source_default") }
    }
    const source = configSource()
    return {
      id: cfg.profile,
      isImplicit: false,
      sourceLabel: source === "project"
        ? t("dialog.sandbox.config_source_project")
        : source === "global"
          ? t("dialog.sandbox.config_source_global")
          : t("dialog.sandbox.config_source_default"),
    }
  })

  const networkEnabled = createMemo(() => {
    const rt = runtimeOverride()
    if (rt?.network) return rt.network.enabled
    const cfg = sandboxConfig()
    if (cfg?.network) return cfg.network.enabled
    if (process.platform === "win32" && effectiveProfile().id !== "full-access") return true
    // Fall back to profile's network (BUILTIN_PROFILES or custom profile definition)
    const profileId = effectiveProfile().id
    const profileDef = BUILTIN_PROFILES[profileId as keyof typeof BUILTIN_PROFILES] ?? cfg?.profiles?.[profileId]
    if (profileDef?.network) return profileDef.network.enabled
    return true
  })

  const customProfiles = createMemo(() => {
    const cfg = sandboxConfig()
    if (!cfg?.profiles) return []
    return Object.entries(cfg.profiles).map(([id, def]) => ({ id, ...def }))
  })

  const platform = createMemo(() => process.platform)

  // ── Mode tab: write status ──
  const [writeStatus, setWriteStatus] = createSignal<{ type: "idle" | "success" | "error"; path?: string; error?: string; projectOverride?: { profile: string; filepath: string } }>({ type: "idle" })

  const writeTargetPath = createMemo(() => findGlobalConfigFile())

  const allowedProfiles = createMemo(() => sandboxConfig()?.allowed_profiles)

  function getDisableReason(profileId: string): string | undefined {
    const whitelist = allowedProfiles()
    if (whitelist && !whitelist.includes(profileId)) {
      return t("dialog.sandbox.disabled_not_in_whitelist")
    }
    if (process.platform !== "win32") return undefined
    const validated = validateSandboxConfigShape(sandboxConfig())
    if (!validated || SandboxResolver.validateAll(validated).length > 0) return undefined
    const error = windowsProfileValidationError(validated, profileId, runtimeOverride())
    if (error) return t("dialog.sandbox.disabled_windows_unsupported", { reason: error.message })
    return undefined
  }

  async function selectProfile(profileId: string) {
    const reason = getDisableReason(profileId)
    if (reason) return undefined

    setWriteStatus({ type: "idle" })

    try {
      const filepath = await writeSandboxProfile(profileId)
      // FR-CFG-009 (S-SESS-1): inject runtime override so current session uses
      // the new profile immediately, without requiring a restart (S-MERGE-6).
      await setRuntimeSandbox({ profile: profileId })
      setCurrentSandboxProfile(profileId)
      void refreshRuntimeOverride()
      void refreshConfigSource()
      // UI-12: if project layer declares a profile, show override hint
      const projectResult = await readProjectSandboxProfile(project.instance.directory())
      if (projectResult) {
        setWriteStatus({ type: "success", path: filepath, projectOverride: projectResult })
      } else {
        setWriteStatus({ type: "success", path: filepath })
      }
      void sync.bootstrap({ fatal: false }).catch(() => {})
    } catch (err) {
      setWriteStatus({ type: "error", error: String(err) })
    }
  }

  const builtinOptions = createMemo<DialogSelectOption<string>[]>(() => {
    return [
      ...(process.platform === "win32"
        ? []
        : [
            {
               title: "Read-only",
              value: "read-only",
              description: t("dialog.sandbox.readonly_desc"),
            },
          ]),
      {
        title: "Workspace",
        value: "workspace",
        description: t("dialog.sandbox.workspace_desc"),
      },
      {
        title: "Full-access",
        value: "full-access",
        description: t("dialog.sandbox.full_access_desc"),
      },
    ]
  })

  // ── Custom tab: config validation ──
  const validationErrors = createMemo(() => {
    const cfg = sandboxConfig()
    if (!cfg) return []
    // S7: if shape validation fails, do not pass malformed config to validateAll
    // (which assumes a well-formed SandboxConfig). Return a generic shape error.
    const validated = validateSandboxConfigShape(cfg)
    if (!validated) {
      return [{ rule: "shape", message: "Sandbox config has an invalid shape and could not be validated", path: "sandbox" }]
    }
    const errors = SandboxResolver.validateAll(validated)
    if (errors.length > 0 || process.platform !== "win32") return errors
    const error = windowsProfileValidationError(validated, effectiveProfile().id, runtimeOverride())
    return error ? [error] : []
  })

  const customOptions = createMemo<DialogSelectOption<string>[]>(() =>
    customProfiles().map((p) => {
      const disableReason = getDisableReason(p.id)
      return {
        title: p.id,
        value: p.id,
        description: disableReason ?? (p.extends ? `extends: ${p.extends}` : p.description),
        disabled: !!disableReason,
      }
    }),
  )

  // ── Tab navigation ──
  useBindings(() => ({
    commands: [
      {
        name: "dialog.sandbox.tab.prev",
        title: t("dialog.sandbox_tab_prev"),
        category: t("category.dialog"),
        run: () => {
          setWriteStatus({ type: "idle" })
          setActiveTab((prev) => wrapPrev(SANDBOX_TABS, prev))
        },
      },
      {
        name: "dialog.sandbox.tab.next",
        title: t("dialog.sandbox_tab_next"),
        category: t("category.dialog"),
        run: () => {
          setWriteStatus({ type: "idle" })
          setActiveTab((prev) => wrapNext(SANDBOX_TABS, prev))
        },
      },
    ],
    bindings: tuiConfig.keybinds.gather("dialog.sandbox", [
      "dialog.sandbox.tab.prev",
      "dialog.sandbox.tab.next",
    ]),
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      {/* Title bar — esc rendered here (matches dialog-usage tabbed layout).
        DialogSelect below renders its own esc too; we pass titleView={<></>}
        and the inner title bar collapses, so only this outer esc shows. */}
      <box flexDirection="row" justifyContent="space-between">
        <text fg={TAB_BG} attributes={TextAttributes.BOLD}>
          {t("dialog.sandbox.title")}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          {t("dialog.esc")}
        </text>
      </box>

      {/* Tab bar */}
      <box flexDirection="row" gap={2}>
        <For each={SANDBOX_TABS}>
          {(tab) => {
            const active = () => tab === activeTab()
            return (
              <box
                backgroundColor={active() ? TAB_BG : undefined}
                onMouseUp={() => setActiveTab(tab)}
              >
                <text fg={active() ? TAB_FG : theme.text} attributes={active() ? TextAttributes.BOLD : undefined}>
                  {` ${t(TAB_KEYS[tab])} `}
                </text>
              </box>
            )
          }}
        </For>
      </box>

      {/* Tab content */}
      <Switch>
        <Match when={activeTab() === "mode"}>
          <box flexDirection="column" gap={1}>
            {/* Write status */}
            <Show when={writeStatus().type === "success"}>
              <text fg={theme.success}>
                {t("dialog.sandbox.write_success")}: {writeStatus().path}
              </text>
              {/* UI-12: project layer override hint */}
              <Show when={writeStatus().projectOverride}>
                <text fg={theme.warning}>
                  {t("dialog.sandbox.project_override_hint", { path: writeStatus().projectOverride!.filepath })}
                </text>
              </Show>
            </Show>
            <Show when={writeStatus().type === "error"}>
              <text fg={theme.error}>
                {t("dialog.sandbox.write_error")}: {writeStatus().error}
              </text>
            </Show>

            {/* Built-in profiles list */}
            <DialogSelect
              title=""
              hideHeader
              options={builtinOptions()}
              current={
                builtinOptions().some((option) => option.value === effectiveProfile().id)
                  ? effectiveProfile().id
                  : undefined
              }
              skipFilter
              renderFilter={false}
              onSelect={(opt) => {
                void selectProfile(opt.value)
              }}
              footer={
                <box flexDirection="column" gap={0}>
                  <text fg={theme.textMuted}>
                    {t("dialog.sandbox.write_target")}: {writeTargetPath()}
                  </text>
                  {/* Status summary */}
                  <text fg={theme.text}>
                    {t("dialog.sandbox.status_profile")}: {profileDisplayName(effectiveProfile().id)}
                    {effectiveProfile().isImplicit ? ` (${t("dialog.sandbox.implicit")})` : ""}
                  </text>
                  <text fg={theme.textMuted}>
                    {t("dialog.sandbox.status_network")}: {networkEnabled() ? t("dialog.sandbox.on") : t("dialog.sandbox.off")}
                    {"  |  "}
                    {t("dialog.sandbox.status_source")}: {effectiveProfile().sourceLabel}
                  </text>
                  <text fg={theme.textMuted}>
                    {t("dialog.sandbox.home_platform")}: {platform()} | {t("dialog.sandbox.home_capability")}:{" "}
                    {platform() === "darwin"
                      ? "macos-seatbelt"
                      : platform() === "win32"
                        ? "windows-unelevated"
                        : "none"}
                  </text>
                  <KeyChip key="←/→" label={t("dialog.sandbox.tab_switch")} />
                </box>
              }
            />
          </box>
        </Match>

        <Match when={activeTab() === "custom"}>
          <box flexDirection="column" gap={1}>
            {/* Write status — same as Mode tab */}
            <Show when={writeStatus().type === "success"}>
              <text fg={theme.success}>
                {t("dialog.sandbox.write_success")}: {writeStatus().path}
              </text>
              <Show when={writeStatus().projectOverride}>
                <text fg={theme.warning}>
                  {t("dialog.sandbox.project_override_hint", { path: writeStatus().projectOverride!.filepath })}
                </text>
              </Show>
            </Show>
            <Show when={writeStatus().type === "error"}>
              <text fg={theme.error}>
                {t("dialog.sandbox.write_error")}: {writeStatus().error}
              </text>
            </Show>

            {/* Validation errors */}
            <Show when={validationErrors().length > 0}>
              <box flexDirection="column" gap={0}>
                <For each={validationErrors()}>
                  {(err) => (
                    <text fg={theme.error}>
                      {`[${err.rule}] ${err.message}${err.path ? ` (at ${err.path})` : ""}`}
                    </text>
                  )}
                </For>
              </box>
            </Show>

            {/* Custom profiles list or empty state */}
            <Show
              when={customProfiles().length > 0}
              fallback={
                <box flexDirection="column" gap={1} paddingTop={1} paddingBottom={1}>
                  <text fg={theme.textMuted}>{t("dialog.sandbox.custom_no_profiles")}</text>
                  <text fg={theme.textMuted}>{t("dialog.sandbox.custom_edit_in_config")}</text>
                  <KeyChip key="←/→" label={t("dialog.sandbox.tab_switch")} />
                </box>
              }
            >
              <DialogSelect
                title=""
                hideHeader
                options={customOptions()}
                current={effectiveProfile().id}
                onSelect={(opt) => {
                  if (opt.disabled) return
                  void selectProfile(opt.value)
                }}
                footer={
                  <box flexDirection="column" gap={0}>
                    <text fg={theme.textMuted}>{t("dialog.sandbox.custom_edit_in_config")}</text>
                    <KeyChip key="←/→" label={t("dialog.sandbox.tab_switch")} />
                  </box>
                }
              />
            </Show>
          </box>
        </Match>
      </Switch>
    </box>
  )
}

function KeyChip(props: { key: string; label: string }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" gap={1}>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        {props.key}
      </text>
      <text fg={theme.textMuted}>{props.label}</text>
    </box>
  )
}
