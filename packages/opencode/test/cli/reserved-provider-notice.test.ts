import { beforeEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  __resetReservedProviderNotice,
  markReservedProviderNoticeShown,
  reservedProviderConfigFileName,
  reservedProviderNoticePending,
  wrapNoticeMessage,
} from "@/cli/deveco-ui/reserved-provider-notice"

beforeEach(() => {
  __resetReservedProviderNotice()
})

test("is pending only while a user provider.deveco entry exists", () => {
  expect(reservedProviderNoticePending(undefined)).toBe(false)
  expect(reservedProviderNoticePending({})).toBe(false)
  expect(reservedProviderNoticePending({ provider: { volcengine: {} } })).toBe(false)
  expect(reservedProviderNoticePending({ provider: { deveco: { options: {} } } })).toBe(true)
})

test("delivers the notice at most once per process", () => {
  // Both surfaces (entry page and home dialog) consult the same flag, so the second one stays
  // silent instead of repeating the same warning after sign-in.
  const config = { provider: { deveco: {} } }
  expect(reservedProviderNoticePending(config)).toBe(true)
  markReservedProviderNoticeShown()
  expect(reservedProviderNoticePending(config)).toBe(false)
})

test("a reset re-arms the notice for the next test", () => {
  markReservedProviderNoticeShown()
  __resetReservedProviderNotice()
  expect(reservedProviderNoticePending({ provider: { deveco: {} } })).toBe(true)
})

test("keeps latin tokens such as deveco.jsonc on one line", () => {
  const wrapped = wrapNoticeMessage(
    'The providerId value "deveco" in deveco.jsonc is reserved for built-in models. To use custom models, set providerId to another value.',
  )
  // The renderer's own word wrapping used to split at the dot; pre-wrapping must not.
  expect(wrapped).not.toContain("deveco.\njsonc")
  expect(wrapped.split("\n").every((line) => [...line].length <= 48)).toBe(true)
})

test("packs CJK lines instead of leaving the tail half empty", () => {
  const wrapped = wrapNoticeMessage(
    'deveco.jsonc 配置文件中的 providerId 值 "deveco" 已预留给内置模型；如需使用自定义模型，请将该字段改为其他值。',
  )
  const lines = wrapped.split("\n")
  expect(lines.length).toBeGreaterThan(1)
  // Every line except the last should be close to the column budget (CJK counts as two).
  for (const line of lines.slice(0, -1)) {
    const width = [...line].reduce(
      (sum, char) => sum + (/[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/.test(char) ? 2 : 1),
      0,
    )
    // Closing punctuation may hang one glyph past the budget.
    expect(width).toBeGreaterThan(40)
    expect(width).toBeLessThanOrEqual(50)
  }
})

function tempConfigDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reserved-provider-"))
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content)
  return dir
}

test("names the json file when that is the one declaring provider.deveco", () => {
  const dir = tempConfigDir({ "deveco.json": JSON.stringify({ provider: { deveco: { options: {} } } }) })
  expect(reservedProviderConfigFileName(dir)).toBe("deveco.json")
})

test("names the jsonc file when that is the one declaring provider.deveco", () => {
  const dir = tempConfigDir({ "deveco.jsonc": '{\n  // reserved id\n  "provider": { "deveco": {} }\n}\n' })
  expect(reservedProviderConfigFileName(dir)).toBe("deveco.jsonc")
})

test("prefers the later-merged file when both declare provider.deveco", () => {
  // Config merges json then jsonc, so the jsonc entry is the one that survives.
  const dir = tempConfigDir({
    "deveco.json": JSON.stringify({ provider: { deveco: {} } }),
    "deveco.jsonc": JSON.stringify({ provider: { deveco: {} } }),
  })
  expect(reservedProviderConfigFileName(dir)).toBe("deveco.jsonc")
})

test("falls back to the config file on disk when none declares provider.deveco", () => {
  const dir = tempConfigDir({ "deveco.json": JSON.stringify({ $schema: "https://opencode.ai/config.json" }) })
  expect(reservedProviderConfigFileName(dir)).toBe("deveco.json")
})

test("falls back to the fresh-install name when no config file exists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reserved-provider-empty-"))
  expect(reservedProviderConfigFileName(dir)).toBe("deveco.jsonc")
})

test("ignores a broken config file instead of throwing during startup", () => {
  const dir = tempConfigDir({ "deveco.json": "{ not json" })
  expect(reservedProviderConfigFileName(dir)).toBe("deveco.json")
})
