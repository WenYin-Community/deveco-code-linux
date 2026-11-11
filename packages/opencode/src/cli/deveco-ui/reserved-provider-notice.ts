import fs from "node:fs"
import path from "node:path"
import { type ParseError, parse as parseJsonc } from "jsonc-parser"
import { Global } from "@opencode-ai/core/global"

/**
 * One-shot delivery for the "provider.deveco is reserved" notice.
 *
 * The notice has two candidate surfaces: the entry page (not signed in) and the home dialog
 * (signed in). A user must only see it once per process, so both surfaces ask this module whether
 * the notice is still pending and mark it delivered when they render it.
 */
let shown = false

export function reservedProviderNoticePending(config: { provider?: Record<string, unknown> } | undefined): boolean {
  return !shown && config?.provider?.deveco !== undefined
}

export function markReservedProviderNoticeShown(): void {
  shown = true
}

/** Test-only: reset the one-shot state between cases. */
export function __resetReservedProviderNotice(): void {
  shown = false
}

// Same names, same order as Config's global loader; the last one to merge wins, so the scan below
// runs in that order to name the file whose entry actually survived.
const CONFIG_CANDIDATES = ["deveco.jsonc", "deveco.json", "config.json"] as const

/**
 * Name of the config file the user should edit, e.g. "deveco.json" or "deveco.jsonc".
 *
 * The schema allows either extension, so a hardcoded name in the notice told json users to edit a
 * file that does not exist. Prefer the file that actually declares provider.deveco; otherwise fall
 * back to the config file present on disk; otherwise the name a fresh install gets.
 */
export function reservedProviderConfigFileName(configDir: string = Global.Path.config): string {
  const files = CONFIG_CANDIDATES.map((name) => path.join(configDir, name))
  const declaring = files.find(declaresReservedProvider)
  if (declaring) return path.basename(declaring)
  const existing = files.find((file) => fs.existsSync(file))
  return path.basename(existing ?? path.join(configDir, CONFIG_CANDIDATES[0]))
}

function declaresReservedProvider(file: string): boolean {
  if (!fs.existsSync(file)) return false
  try {
    const errors: ParseError[] = []
    const value: unknown = parseJsonc(fs.readFileSync(file, "utf8"), errors, {
      allowTrailingComma: true,
      disallowComments: false,
    })
    if (!isRecord(value) || !isRecord(value.provider)) return false
    return value.provider.deveco !== undefined
  } catch {
    // A half-written or unreadable file must not break the startup notice.
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

// CJK ideographs and full-width punctuation: terminals render these two columns wide.
const WIDE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/

// Closing punctuation must not start a line, so it may overhang the column budget by one glyph.
const CLOSING = /[\u3001\u3002\uff0c\uff0e\uff1b\uff1a\uff1f\uff01\uff09\u300b\u300d\u300f\u201d\u2019\u2026]/

const SPACES = /^\s+$/

/** Column width of one code point in a monospace terminal. */
export function noticeCharWidth(char: string): number {
  return WIDE.test(char) ? 2 : 1
}

type WrapState = {
  lines: string[]
  line: string
  width: number
  pendingSpace: boolean
}

/**
 * Pre-wrap the notice for the fixed-width dialog.
 *
 * The TUI text renderer breaks "word" wrapped text at punctuation, which split `deveco.jsonc`
 * across lines, and its "char" mode never fills CJK lines. Wrapping here keeps latin tokens (file
 * names, the reserved id) intact, packs CJK lines, and lets the dialog render with wrapMode
 * "none" so the layout is exactly what this function produced.
 */
export function wrapNoticeMessage(message: string, columns = 48): string {
  const state: WrapState = { lines: [], line: "", width: 0, pendingSpace: false }
  for (const chunk of message.split(/(\s+)/)) placeChunk(state, chunk, columns)
  if (state.line !== "") flushLine(state)
  return state.lines.join("\n")
}

function placeChunk(state: WrapState, chunk: string, columns: number): void {
  if (chunk === "") return
  if (SPACES.test(chunk)) {
    state.pendingSpace = state.line !== ""
    return
  }
  const width = textWidth(chunk)
  // CJK runs (or one over-long token) go character by character so lines stay full; latin tokens
  // stay intact so a file name is never split at its dot.
  if (!WIDE.test(chunk) && width <= columns) {
    placeToken(state, chunk, columns)
    return
  }
  for (const char of chunk) placeCharacter(state, char, columns)
  state.pendingSpace = false
}

function textWidth(text: string): number {
  let total = 0
  for (const char of text) total += noticeCharWidth(char)
  return total
}

function placeToken(state: WrapState, token: string, columns: number): void {
  const separator = state.pendingSpace && state.line !== "" ? 1 : 0
  if (state.line !== "" && state.width + separator + token.length > columns) flushLine(state)
  appendPendingSpace(state)
  state.line += token
  state.width += token.length
  state.pendingSpace = false
}

function placeCharacter(state: WrapState, char: string, columns: number): void {
  const width = noticeCharWidth(char)
  const separator = state.pendingSpace && state.line !== "" ? 1 : 0
  const overflows = state.line !== "" && state.width + separator + width > columns
  if (overflows && !CLOSING.test(char)) flushLine(state)
  appendPendingSpace(state)
  state.line += char
  state.width += width
}

function appendPendingSpace(state: WrapState): void {
  if (!state.pendingSpace || state.line === "") return
  state.line += " "
  state.width += 1
  state.pendingSpace = false
}

function flushLine(state: WrapState): void {
  state.lines.push(state.line.trimEnd())
  state.line = ""
  state.width = 0
  state.pendingSpace = false
}
