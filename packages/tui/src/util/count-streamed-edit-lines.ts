const oldStringRe = /"oldString"\s*:\s*"((?:[^"\\]|\\.)*)/
const newStringRe = /"newString"\s*:\s*"((?:[^"\\]|\\.)*)/

export function countStreamedEditLines(raw: string): { added: number; removed: number } {
  return {
    added: countLines(raw.match(newStringRe)?.[1]),
    removed: countLines(raw.match(oldStringRe)?.[1]),
  }
}

export function countStreamedLines(raw: string, key: string): number {
  const match = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`))
  return countLines(match?.[1])
}

function countLines(value: string | undefined): number {
  if (!value) return 0
  // Strip escaped backslashes first so `\\n` (literal backslash + n) cannot fake a newline.
  const newlines = value.replace(/\\\\/g, "").match(/\\n|\\u000[aA]/g)?.length ?? 0
  return newlines + 1
}
