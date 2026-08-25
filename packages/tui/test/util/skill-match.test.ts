import { describe, expect, test } from "bun:test"
import { matchSkillExpansion } from "../../src/util/skill-match"

function skill(name: string, content: string) {
  return { name, location: `/tmp/${name}/SKILL.md`, content }
}

const body = "# DevEco CLI\n\n`devecocli` wraps DevEco Studio's toolchain."

describe("matchSkillExpansion", () => {
  test("matches text equal to the trimmed skill body", () => {
    const result = matchSkillExpansion(body, [skill("devecocli", body + "\n")])
    expect(result?.skill.name).toBe("devecocli")
    expect(result?.args).toBe("")
  })

  test("matches body followed by arguments", () => {
    const result = matchSkillExpansion(`${body}\n\nstart Pixel`, [skill("devecocli", body)])
    expect(result?.skill.name).toBe("devecocli")
    expect(result?.args).toBe("start Pixel")
  })

  test("trims whitespace around arguments", () => {
    const result = matchSkillExpansion(`${body}\n\n  start Pixel  `, [skill("devecocli", body)])
    expect(result?.args).toBe("start Pixel")
  })

  test("matches the only skill whose body fits among several", () => {
    const skills = [skill("alpha", "# Alpha\n\nAlpha body."), skill("devecocli", body)]
    expect(matchSkillExpansion(body, skills)?.skill.name).toBe("devecocli")
    expect(matchSkillExpansion("# Alpha\n\nAlpha body.", skills)?.skill.name).toBe("alpha")
  })

  test("returns undefined for unrelated text", () => {
    expect(matchSkillExpansion("help me fix this bug", [skill("devecocli", body)])).toBeUndefined()
    expect(matchSkillExpansion(body.slice(0, 10), [skill("devecocli", body)])).toBeUndefined()
  })

  test("returns undefined when skills are not loaded", () => {
    expect(matchSkillExpansion(body, undefined)).toBeUndefined()
  })

  test("returns undefined for empty text", () => {
    expect(matchSkillExpansion("", [skill("devecocli", body)])).toBeUndefined()
  })

  test("skills with empty bodies never match", () => {
    const skills = [skill("empty", "   \n"), skill("devecocli", body)]
    expect(matchSkillExpansion("   \n", skills)).toBeUndefined()
    expect(matchSkillExpansion(body, skills)?.skill.name).toBe("devecocli")
  })
})

describe("matchSkillExpansion with template substitution", () => {
  test("matches a $ARGUMENTS body invoked without arguments", () => {
    const content = "Glossary term: $ARGUMENTS\n\nLook it up."
    const result = matchSkillExpansion("Glossary term: \n\nLook it up.", [skill("glossary", content)])
    expect(result?.skill.name).toBe("glossary")
    expect(result?.args).toBe("")
  })

  test("recovers arguments from a single $ARGUMENTS occurrence", () => {
    const content = "Glossary term: $ARGUMENTS\n\nLook it up."
    const result = matchSkillExpansion("Glossary term: concurrency\n\nLook it up.", [skill("glossary", content)])
    expect(result?.skill.name).toBe("glossary")
    expect(result?.args).toBe("concurrency")
  })

  test("recovers arguments shared by multiple $ARGUMENTS occurrences", () => {
    const content = "Find $ARGUMENTS in the index, then open $ARGUMENTS."
    const result = matchSkillExpansion("Find arc in the index, then open arc.", [skill("lookup", content)])
    expect(result?.skill.name).toBe("lookup")
    expect(result?.args).toBe("arc")
  })

  test("rejects text whose length cannot come from repeated $ARGUMENTS splices", () => {
    const content = "Find $ARGUMENTS in the index, then open $ARGUMENTS."
    expect(matchSkillExpansion("Find arc in the index, then open circle.", [skill("lookup", content)])).toBeUndefined()
  })

  test("matches a placeholder body invoked without arguments", () => {
    const content = "First $1 second $2\n\nDone."
    const result = matchSkillExpansion("First  second \n\nDone.", [skill("pair", content)])
    expect(result?.skill.name).toBe("pair")
    expect(result?.args).toBe("")
  })

  test("cannot recover positional arguments and falls back to full rendering", () => {
    const content = "First $1 second $2\n\nDone."
    expect(matchSkillExpansion("First a second b\n\nDone.", [skill("pair", content)])).toBeUndefined()
  })

  test("matches a body whose shell interpolation produced no output", () => {
    const content = "Row `Terminate execution!` then `quoted` done\n\nInvestigate."
    const result = matchSkillExpansion("Row `Terminate executionquoted` done\n\nInvestigate.", [
      skill("runtime-fix", content),
    ])
    expect(result?.skill.name).toBe("runtime-fix")
    expect(result?.args).toBe("")
  })

  test("matches appended arguments when shell interpolation produced no output", () => {
    const content = "Run !`git status` and report."
    const result = matchSkillExpansion("Run  and report.\n\nafter deploy", [skill("report", content)])
    expect(result?.skill.name).toBe("report")
    expect(result?.args).toBe("after deploy")
  })

  test("matches a $ARGUMENTS body with shell interpolation when output is empty and no args", () => {
    const content = "Generate from !`bun script/raw-changelog.ts $ARGUMENTS`"
    const result = matchSkillExpansion("Generate from", [skill("changelog", content)])
    expect(result?.skill.name).toBe("changelog")
    expect(result?.args).toBe("")
  })

  test("cannot recover arguments for $ARGUMENTS bodies containing shell interpolation", () => {
    const content = "Generate from !`bun script/raw-changelog.ts $ARGUMENTS`"
    expect(matchSkillExpansion("Generate from latest tag", [skill("changelog", content)])).toBeUndefined()
  })
})
