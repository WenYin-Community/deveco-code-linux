import { Config } from "@/config/config"
import { AppRuntime } from "@/effect/app-runtime"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Installation } from "@/installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import * as prompts from "@clack/prompts"
import { errorMessage } from "@/util/error"
import { t } from "@/cli/i18n"
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

const BAR_WIDTH = 28

const STAGES = [
  () => t("upgrade.stage_resolving"),
  () => t("upgrade.stage_downloading"),
  () => t("upgrade.stage_installing"),
  () => t("upgrade.stage_linking"),
]

const STAGE_COLORS = ["\x1b[35m", "\x1b[33m", "\x1b[34m", "\x1b[36m"]

const GRADIENT_STOPS: [number, number, number][] = [
  [255, 100, 200],
  [200, 100, 255],
  [100, 150, 255],
  [50, 200, 255],
  [80, 255, 180],
  [100, 255, 100],
]

function gradientColor(pos: number) {
  const n = GRADIENT_STOPS.length - 1
  const idx = Math.min(pos * n, n - 0.001)
  const i = Math.floor(idx)
  const t = idx - i
  const c1 = GRADIENT_STOPS[i]
  const c2 = GRADIENT_STOPS[i + 1]
  const r = Math.round(c1[0] + (c2[0] - c1[0]) * t)
  const g = Math.round(c1[1] + (c2[1] - c1[1]) * t)
  const b = Math.round(c1[2] + (c2[2] - c1[2]) * t)
  return `\x1b[38;2;${r};${g};${b}m`
}

function renderBar(pct: number, done: boolean) {
  const filled = Math.round(BAR_WIDTH * pct / 100)
  const bar = Array.from({ length: filled }, (_, i) =>
    (done ? "\x1b[32m" : gradientColor(i / BAR_WIDTH)) + "━",
  ).join("")
  return bar + "\x1b[90m" + "─".repeat(BAR_WIDTH - filled) + "\x1b[0m"
}

function stageText(stageIdx: number, done: boolean, text: string) {
  return (done ? "\x1b[32m" : STAGE_COLORS[stageIdx]) + text + "\x1b[0m"
}

function stageForPct(pct: number) {
  return Math.min(STAGES.length - 1, Math.floor(pct / 25))
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

    let progress = 0
    const timer = setInterval(() => {
      const increment = Math.max(0.3, (10 - progress * 0.08) * (Math.random() * 0.4 + 0.6))
      progress = Math.min(92, progress + increment)
      const pct = Math.round(progress)
      const stageIdx = stageForPct(pct)
      const stage = STAGES[stageIdx]()
      spinner.message(`${renderBar(pct, false)} ${pct}%  ${stageText(stageIdx, false, stage)}`)
    }, 300)

    const err = await Installation.upgrade(method, target).catch((e: unknown) => e)

    clearInterval(timer)
    process.off("SIGINT", handler)

    if (err) {
      spinner.message(`${renderBar(Math.round(progress), false)} ${Math.round(progress)}%  \x1b[31m${t("upgrade.failed")}\x1b[0m`)
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

    spinner.message(`${renderBar(100, true)} 100%  \x1b[32m${t("upgrade.complete")}\x1b[0m`)
    spinner.stop(t("upgrade.upgraded_to", { target }))
    await writeUpgradeState({ checked_at: Date.now() })
    prompts.outro("\x1b[1m" + t("upgrade.restart") + "\x1b[0m")
    process.exit(0)
  }
}
