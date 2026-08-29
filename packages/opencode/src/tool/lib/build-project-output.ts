/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import stripAnsi from "strip-ansi"

export const MAX_OUTPUT_LINES = 50
export const TRUNCATE_NOTICE = "--- The log is too long, only the last 50 lines are kept ---"

function splitLines(text: string): string[] {
  if (!text) return []
  return text.split(/\r?\n/)
}

function takeLastLines(lines: string[], max: number): { lines: string[]; truncated: boolean } {
  if (max <= 0 || lines.length === 0) return { lines: [], truncated: false }
  if (lines.length <= max) return { lines, truncated: false }
  return { lines: lines.slice(-max), truncated: true }
}

/** Concatenate streams as stdout then stderr (no section labels). */
export function formatStdoutStderr(stdout: string, stderr: string) {
  const out = stripAnsi(stdout)
  const err = stripAnsi(stderr)
  if (out && err) return `${out}${err}`
  return out || err
}

/**
 * Status line derived from exitCode. Always appended after truncation so
 * evaluators that scan the last N lines for "Build completed successfully"
 * are not fooled by stderr warning floods.
 */
export function formatBuildStatusLine(exitCode: number): string {
  return exitCode === 0
    ? `Build completed successfully (exitCode=${exitCode})`
    : `BUILD FAILED (exitCode=${exitCode})`
}

/**
 * Truncate a single merged log (kept for tests / callers that already joined streams).
 * Prefer {@link formatBuildProjectOutput} for devecocli build, which truncates per stream.
 */
export function truncateOutput(text: string) {
  const lines = splitLines(text)
  if (lines.length <= MAX_OUTPUT_LINES) {
    return { text, truncated: false as const, preview: text }
  }
  const preview = lines.slice(-MAX_OUTPUT_LINES).join("\n")
  return {
    text: `${TRUNCATE_NOTICE}\n${preview}`,
    truncated: true as const,
    preview,
  }
}

/**
 * Format build logs for the model / run metrics.
 *
 * Truncates stdout and stderr separately so a long stderr warning tail cannot
 * push "Build completed successfully" out of the last-N-lines window, then
 * always appends an exitCode-based status line.
 */
export function formatBuildProjectOutput(opts: {
  stdout: string
  stderr: string
  exitCode: number
  maxLines?: number
}) {
  const maxLines = opts.maxLines ?? MAX_OUTPUT_LINES
  const out = stripAnsi(opts.stdout)
  const err = stripAnsi(opts.stderr)
  const fullBody = formatStdoutStderr(opts.stdout, opts.stderr)
  const status = formatBuildStatusLine(opts.exitCode)
  const full = fullBody ? `${fullBody}\n${status}` : status

  const outLines = splitLines(out)
  const errLines = splitLines(err)
  const total = outLines.length + errLines.length

  let outBudget: number
  let errBudget: number
  if (outLines.length === 0) {
    outBudget = 0
    errBudget = maxLines
  } else if (errLines.length === 0) {
    outBudget = maxLines
    errBudget = 0
  } else if (total <= maxLines) {
    outBudget = outLines.length
    errBudget = errLines.length
  } else {
    outBudget = Math.ceil(maxLines / 2)
    errBudget = Math.floor(maxLines / 2)
    if (outLines.length < outBudget) {
      errBudget = maxLines - outLines.length
      outBudget = outLines.length
    } else if (errLines.length < errBudget) {
      outBudget = maxLines - errLines.length
      errBudget = errLines.length
    }
  }

  const outCut = takeLastLines(outLines, outBudget)
  const errCut = takeLastLines(errLines, errBudget)
  const truncated = total > maxLines || outCut.truncated || errCut.truncated

  const previewBody = `${outCut.lines.join("\n")}${errCut.lines.join("\n")}`
  const preview = previewBody ? `${previewBody}\n${status}` : status
  const text = truncated ? `${TRUNCATE_NOTICE}\n${preview}` : preview

  return { text, truncated, preview, full }
}
