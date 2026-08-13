import { Config } from "@/config/config"
import { AppRuntime } from "@/effect/app-runtime"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Installation } from "@/installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import * as prompts from "@clack/prompts"
import { errorMessage } from "@/util/error"
import { t } from "@/cli/i18n"
import { UI } from "@/cli/ui"
import path from "path"
import fs from "fs"
import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"
import { Filesystem } from "@/util/filesystem"
import { GlobalBus } from "@/bus/global"

export type UpgradeDecision = "skip" | "upgrade" | "notify"

export type DecideInput = {
  autoupdate: boolean | "notify" | undefined
  disabled: boolean
  alwaysNotify: boolean
  isLatest: boolean
  method: Installation.Method
}

export function decideUpgrade(input: DecideInput): UpgradeDecision {
  if (input.disabled || input.autoupdate === false) return "skip"
  if (input.isLatest) return "skip"
  if (input.alwaysNotify || input.autoupdate === "notify") return "notify"
  return "upgrade"
}

export type UpgradeState = {
  pending_version?: string
  checked_at: number
}

const FRESH_MS = 24 * 60 * 60 * 1000

export function isStateFresh(state: UpgradeState): boolean {
  return Date.now() - state.checked_at < FRESH_MS
}

function readUpgradeState(): UpgradeState | undefined {
  try {
    const kvPath = path.join(Global.Path.state, "kv.json")
    const content = fs.readFileSync(kvPath, "utf-8")
    const kv = JSON.parse(content) as Record<string, unknown>
    const upgrade = kv.upgrade
    if (typeof upgrade === "object" && upgrade !== null) return upgrade as UpgradeState
  } catch {}
}

async function writeUpgradeState(state: UpgradeState) {
  const file = path.join(Global.Path.state, "kv.json")
  await Flock.withLock(`tui-kv:${file}`, async () => {
    const kv = await Filesystem.readJson<Record<string, unknown>>(file).catch(() => ({} as Record<string, unknown>))
    kv.upgrade = state
    const temp = `${file}.${process.pid}.tmp`
    await Bun.write(temp, JSON.stringify(kv, null, 2))
    await fs.promises.rename(temp, file)
  })
}

function readKVSkippedVersion(): string | undefined {
  try {
    const kvPath = path.join(Global.Path.state, "kv.json")
    const content = fs.readFileSync(kvPath, "utf-8")
    const kv = JSON.parse(content) as Record<string, unknown>
    const skipped = kv.skipped_version
    if (typeof skipped === "string") return skipped
  } catch {}
}

export async function checkPendingUpgrade() {
  if (Installation.isLocal()) return
  const state = readUpgradeState()
  if (!state || !isStateFresh(state)) return
  if (!state.pending_version) return
  if (InstallationVersion === state.pending_version) return

  const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal()))
  const method = await Installation.method()
  const skipped = readKVSkippedVersion()
  if (skipped && state.pending_version === skipped) return

  const decision = decideUpgrade({
    autoupdate: config.autoupdate,
    disabled: Flag.DEVECO_DISABLE_AUTOUPDATE,
    alwaysNotify: Flag.DEVECO_ALWAYS_NOTIFY_UPDATE,
    isLatest: false,
    method,
  })

  if (decision === "skip") return

  UI.empty()
  UI.println(UI.logo("  "))
  UI.empty()
  prompts.intro(t("upgrade.intro"))
  prompts.log.info(t("upgrade.update_available", { current: InstallationVersion, latest: state.pending_version }))

  if (decision === "notify") {
    const confirm = await prompts.confirm({
      message: t("upgrade.upgrade_now"),
      initialValue: true,
    })
    if (!confirm || prompts.isCancel(confirm)) {
      prompts.outro(t("upgrade.skipping"))
      return
    }
  }

  const isUnknown = method === "unknown"
  await runUpgradeWithInterrupt(isUnknown ? "npm" : method, isUnknown ? "latest" : state.pending_version)
}

export async function checkUpgradeBackground() {
  if (Installation.isLocal()) return
  if (Flag.DEVECO_DISABLE_AUTOUPDATE) return
  const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal()))
  const method = await Installation.method()
  const latest = await Installation.latest(method).catch(() => undefined)

  if (!latest) return

  const now = Date.now()

  if (InstallationVersion === latest) {
    await writeUpgradeState({ checked_at: now })
    return
  }

  const prevState = readUpgradeState()
  const isNewVersion = !prevState?.pending_version || prevState.pending_version !== latest

  await writeUpgradeState({ pending_version: latest, checked_at: now })

  const decision = decideUpgrade({
    autoupdate: config.autoupdate,
    disabled: Flag.DEVECO_DISABLE_AUTOUPDATE,
    alwaysNotify: Flag.DEVECO_ALWAYS_NOTIFY_UPDATE,
    isLatest: false,
    method,
  })

  if (decision === "notify" && isNewVersion) {
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Installation.Event.UpdateAvailable.type,
        properties: { version: latest },
      },
    })
  }
}

async function runUpgradeWithInterrupt(method: Installation.Method, target: string) {
  while (true) {
    let interrupted = false
    const handler = () => { interrupted = true }
    process.on("SIGINT", handler)

    const spinner = prompts.spinner()
    spinner.start(t("upgrade.installing_via", { method }))

    const err = await Installation.upgrade(method, target).catch((e: unknown) => e)

    process.off("SIGINT", handler)

    if (err) {
      spinner.stop(t("upgrade.upgrade_failed"), 1)
      if (interrupted) {
        const cont = await prompts.confirm({
          message: t("upgrade.interrupted"),
          initialValue: true,
        })
        if (prompts.isCancel(cont) || !cont) {
          prompts.outro(t("upgrade.cancelled"))
          process.exit(0)
        }
        continue
      }
      prompts.log.error(
        err instanceof Installation.UpgradeFailedError ? err.stderr : errorMessage(err),
      )
      prompts.outro(t("upgrade.done"))
      return
    }

    spinner.stop(t("upgrade.upgraded_to", { target }))
    await writeUpgradeState({ checked_at: Date.now() })
    prompts.outro("\x1b[1m" + t("upgrade.restart") + "\x1b[0m")
    process.exit(0)
  }
}
