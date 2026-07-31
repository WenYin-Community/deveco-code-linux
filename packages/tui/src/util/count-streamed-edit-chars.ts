const oldStringRe = /"oldString"\s*:\s*"((?:[^"\\]|\\.)*)/
const newStringRe = /"newString"\s*:\s*"((?:[^"\\]|\\.)*)/

export function countStreamedEditChars(raw: string): { added: number; removed: number } {
  return {
    added: countChars(raw.match(newStringRe)?.[1]),
    removed: countChars(raw.match(oldStringRe)?.[1]),
  }
}

export function countStreamedChars(raw: string, key: string): number {
  const match = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`))
  return countChars(match?.[1])
}

function countChars(value: string | undefined): number {
  if (!value) return 0
  return value.length
}
