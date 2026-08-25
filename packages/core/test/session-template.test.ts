import { describe, expect, test } from "bun:test"
import { SessionTemplate } from "@opencode-ai/core/session/template"

describe("SessionTemplate.expand", () => {
  test("appends raw arguments after a blank line for plain templates", () => {
    expect(SessionTemplate.expand("Summarize this", "foo bar")).toBe("Summarize this\n\nfoo bar")
  })

  test("does not append empty or whitespace-only arguments", () => {
    expect(SessionTemplate.expand("Summarize this", "")).toBe("Summarize this")
    expect(SessionTemplate.expand("Summarize this", "   ")).toBe("Summarize this")
  })

  test("splices $ARGUMENTS with the raw argument string", () => {
    expect(SessionTemplate.expand("Translate $ARGUMENTS now", "foo bar")).toBe("Translate foo bar now")
    expect(SessionTemplate.expand("A $ARGUMENTS B $ARGUMENTS", "x y")).toBe("A x y B x y")
  })

  test("replaces positional placeholders with parsed arguments", () => {
    expect(SessionTemplate.expand("First $1 second $2", "a b")).toBe("First a second b")
  })

  test("the highest placeholder consumes the remaining arguments", () => {
    expect(SessionTemplate.expand("First $1 rest $2", "a b c d")).toBe("First a rest b c d")
  })

  test("missing positional placeholders expand to empty strings", () => {
    expect(SessionTemplate.expand("First $1 second $2", "a")).toBe("First a second ")
  })

  test("strips surrounding quotes from parsed arguments", () => {
    expect(SessionTemplate.expand("First $1", '"a b"')).toBe("First a b")
  })

  test("parses quoted arguments as single tokens", () => {
    expect(SessionTemplate.expand("First $1 second $2", '"a b" c')).toBe("First a b second c")
  })
})
