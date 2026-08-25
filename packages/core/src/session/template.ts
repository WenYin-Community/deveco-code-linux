const placeholderRegex = /\$(\d+)/g
const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const quoteTrimRegex = /^["']|["']$/g

export function expand(body: string, rawArgs: string): string {
  const args = (rawArgs.match(argsRegex) ?? []).map((arg) => arg.replace(quoteTrimRegex, ""))
  const placeholders = body.match(placeholderRegex) ?? []
  let last = 0
  for (const item of placeholders) {
    const value = Number(item.slice(1))
    if (value > last) last = value
  }
  const withArgs = body.replaceAll(placeholderRegex, (_, index) => {
    const position = Number(index)
    const argIndex = position - 1
    if (argIndex >= args.length) return ""
    if (position === last) return args.slice(argIndex).join(" ")
    return args[argIndex]
  })
  const template = withArgs.replaceAll("$ARGUMENTS", rawArgs)
  if (placeholders.length === 0 && !body.includes("$ARGUMENTS") && rawArgs.trim()) {
    return template + "\n\n" + rawArgs
  }
  return template
}

export * as SessionTemplate from "./template"
