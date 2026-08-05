import path from "path"
import fs from "fs"
import { Global } from "@opencode-ai/core/global"
import en from "./en.json"
import zh from "./zh.json"

// CLI i18n — detects locale from the TUI KV store (user's explicit language
// preference via Ctrl+P). Falls back to English when no preference is set.
// CLI prompts run before the TUI boots, so they cannot reuse TUI's i18next
// instance directly, and macOS locale env vars (LANG etc.) often don't
// reflect the actual display language.

const DICT: Record<string, Record<string, Record<string, string>>> = { en, zh }

function readKVLanguage(): "en" | "zh" | undefined {
  try {
    const kvPath = path.join(Global.Path.state, "kv.json")
    const content = fs.readFileSync(kvPath, "utf-8")
    const kv = JSON.parse(content) as Record<string, unknown>
    const lang = kv.language
    if (lang === "zh") return "zh"
    if (lang === "en") return "en"
  } catch {}
}

function detectCliLocale(): "en" | "zh" {
  return readKVLanguage() ?? "en"
}

const locale = detectCliLocale()

export function t(key: string, vars?: Record<string, string>): string {
  const [ns, k] = key.includes(".") ? key.split(".", 2) : ["", key]
  const nsDict = (DICT[locale] ?? DICT.en)[ns]
  const tmpl = nsDict?.[k] ?? DICT.en[ns]?.[k] ?? key
  if (!vars) return tmpl
  return tmpl.replace(/\{(\w+)\}/g, (_, v) => vars[v] ?? "")
}

export * as CliI18n from "."
