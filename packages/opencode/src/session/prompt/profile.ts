import { Runtime } from "@opencode-ai/core/runtime"

import DEFAULT_ANTHROPIC from "./anthropic.txt"
import DEFAULT_BEAST from "./beast.txt"
import DEFAULT_BTW from "./btw.txt"
import DEFAULT_BUILD_SWITCH from "./build-switch.txt"
import DEFAULT_CODEX from "./codex.txt"
import DEFAULT_COPILOT_GPT_5 from "./copilot-gpt-5.txt"
import DEFAULT_DEFAULT from "./default.txt"
import DEFAULT_GEMINI from "./gemini.txt"
import DEFAULT_GPT from "./gpt.txt"
import DEFAULT_KIMI from "./kimi.txt"
import DEFAULT_PLAN_MODE from "./plan-mode.txt"
import DEFAULT_PLAN_REMINDER_ANTHROPIC from "./plan-reminder-anthropic.txt"
import DEFAULT_PLAN from "./plan.txt"
import DEFAULT_TRINITY from "./trinity.txt"

import STUDIO_ANTHROPIC from "./deveco-studio/anthropic.txt"
import STUDIO_BEAST from "./deveco-studio/beast.txt"
import STUDIO_BTW from "./deveco-studio/btw.txt"
import STUDIO_BUILD_SWITCH from "./deveco-studio/build-switch.txt"
import STUDIO_CODEX from "./deveco-studio/codex.txt"
import STUDIO_COPILOT_GPT_5 from "./deveco-studio/copilot-gpt-5.txt"
import STUDIO_DEFAULT from "./deveco-studio/default.txt"
import STUDIO_GEMINI from "./deveco-studio/gemini.txt"
import STUDIO_GPT from "./deveco-studio/gpt.txt"
import STUDIO_KIMI from "./deveco-studio/kimi.txt"
import STUDIO_PLAN_MODE from "./deveco-studio/plan-mode.txt"
import STUDIO_PLAN_REMINDER_ANTHROPIC from "./deveco-studio/plan-reminder-anthropic.txt"
import STUDIO_PLAN from "./deveco-studio/plan.txt"
import STUDIO_TRINITY from "./deveco-studio/trinity.txt"

export const profiles = {
  default: {
    anthropic: DEFAULT_ANTHROPIC,
    beast: DEFAULT_BEAST,
    btw: DEFAULT_BTW,
    buildSwitch: DEFAULT_BUILD_SWITCH,
    codex: DEFAULT_CODEX,
    copilotGpt5: DEFAULT_COPILOT_GPT_5,
    default: DEFAULT_DEFAULT,
    gemini: DEFAULT_GEMINI,
    gpt: DEFAULT_GPT,
    kimi: DEFAULT_KIMI,
    plan: DEFAULT_PLAN,
    planMode: DEFAULT_PLAN_MODE,
    planReminderAnthropic: DEFAULT_PLAN_REMINDER_ANTHROPIC,
    trinity: DEFAULT_TRINITY,
  },
  "deveco-studio": {
    anthropic: STUDIO_ANTHROPIC,
    beast: STUDIO_BEAST,
    btw: STUDIO_BTW,
    buildSwitch: STUDIO_BUILD_SWITCH,
    codex: STUDIO_CODEX,
    copilotGpt5: STUDIO_COPILOT_GPT_5,
    default: STUDIO_DEFAULT,
    gemini: STUDIO_GEMINI,
    gpt: STUDIO_GPT,
    kimi: STUDIO_KIMI,
    plan: STUDIO_PLAN,
    planMode: STUDIO_PLAN_MODE,
    planReminderAnthropic: STUDIO_PLAN_REMINDER_ANTHROPIC,
    trinity: STUDIO_TRINITY,
  },
} as const

export function select(profile = Runtime.current.agentProfile) {
  return profiles[profile]
}

export const current = select()

export * as SessionPromptProfile from "./profile"
