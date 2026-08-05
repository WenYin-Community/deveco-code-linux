import { Config } from "@/config/config"
import { AppRuntime } from "@/effect/app-runtime"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Installation } from "@/installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import * as prompts from "@clack/prompts"
import { errorMessage } from "@/util/error"
import { t } from "@/cli/i18n"

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

export async function checkAndUpgrade() {
  if (Installation.isLocal()) return
  const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal()))
  const method = await Installation.method()
  if (Flag.DEVECO_DISABLE_AUTOUPDATE || config.autoupdate === false) return
  const spinner = prompts.spinner()
  spinner.start(t("upgrade.checking"))
  const latest = await Installation.latest(method).catch(() => undefined)

  const decision = decideUpgrade({
    autoupdate: config.autoupdate,
    disabled: Flag.DEVECO_DISABLE_AUTOUPDATE,
    alwaysNotify: Flag.DEVECO_ALWAYS_NOTIFY_UPDATE,
    isLatest: !latest || InstallationVersion === latest,
    method,
  })

  if (decision === "skip") {
    spinner.stop(t("upgrade.check_done"))
    return
  }
  spinner.stop("", 0)

  prompts.intro(t("upgrade.intro"))
  prompts.log.info(t("upgrade.update_available", { current: InstallationVersion, latest: latest! }))

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
  await runUpgradeWithInterrupt(isUnknown ? "npm" : method, isUnknown ? "latest" : latest!)
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
    prompts.outro("\x1b[1m" + t("upgrade.restart") + "\x1b[0m")
    process.exit(0)
  }
}
