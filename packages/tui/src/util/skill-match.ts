import { SessionTemplate } from "@opencode-ai/core/session/template"

export type SkillSource = {
  name: string
  content: string
}

export type SkillExpansion = {
  skill: SkillSource
  args: string
}

const SHELL_REGEX = /!`([^`]+)`/g

function expand(body: string, rawArgs: string): string {
  return SessionTemplate.expand(body, rawArgs).replace(SHELL_REGEX, "").trim()
}

export function matchSkillExpansion(text: string, skills: readonly SkillSource[] | undefined): SkillExpansion | undefined {
  if (!skills || text === "") return undefined
  for (const skill of skills) {
    const body = skill.content.trim()
    if (body === "") continue
    const args = matchArgs(text, body)
    if (args !== undefined) return { skill, args }
  }
  return undefined
}

function matchArgs(text: string, body: string): string | undefined {
  if (expand(body, "") === text) return ""
  if (body.match(/\$\d/)) return undefined
  if (!body.includes("$ARGUMENTS")) {
    const base = expand(body, "")
    if (!text.startsWith(base + "\n\n")) return undefined
    return text.slice(base.length + 2).trim()
  }
  return solveArguments(text, body)
}

function solveArguments(text: string, body: string): string | undefined {
  if (body.match(SHELL_REGEX)) return undefined
  const segments = body.split("$ARGUMENTS")
  const candidate =
    segments.length === 2
      ? text.startsWith(segments[0]) && text.endsWith(segments[1])
        ? text.slice(segments[0].length, text.length - segments[1].length)
        : undefined
      : argumentsFromLength(text, segments)
  if (candidate === undefined || expand(body, candidate) !== text) return undefined
  return candidate.trim()
}

function argumentsFromLength(text: string, segments: string[]): string | undefined {
  const sites = segments.length - 1
  const total = segments.reduce((sum, segment) => sum + segment.length, 0)
  const length = (text.length - total) / sites
  if (!Number.isInteger(length) || length < 0) return undefined
  return text.slice(segments[0].length, segments[0].length + length)
}
