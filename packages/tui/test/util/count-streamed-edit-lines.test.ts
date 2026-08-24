import { describe, expect, test } from "bun:test"
import { countStreamedEditLines, countStreamedLines } from "../../src/util/count-streamed-edit-lines"

describe("countStreamedEditLines", () => {
  test("returns zeros for empty string", () => {
    expect(countStreamedEditLines("")).toEqual({ added: 0, removed: 0 })
  })

  test("returns zeros when only filePath has streamed", () => {
    const raw = `{"filePath": "/some/path.ts"`
    expect(countStreamedEditLines(raw)).toEqual({ added: 0, removed: 0 })
  })

  test("counts partial oldString with no newString yet", () => {
    const raw = `{"filePath": "/p.ts", "oldString": "line1\\nline2\\nline3`
    expect(countStreamedEditLines(raw)).toEqual({ added: 0, removed: 3 })
  })

  test("counts complete oldString and partial newString", () => {
    const raw = `{"filePath": "/p.ts", "oldString": "line1\\nline2", "newString": "line1\\nline2\\nline3\\nline4`
    expect(countStreamedEditLines(raw)).toEqual({ added: 4, removed: 2 })
  })

  test("counts both complete oldString and newString", () => {
    const raw = `{"filePath": "/p.ts", "oldString": "a\\nb", "newString": "a\\nb\\nc\\nd"}`
    expect(countStreamedEditLines(raw)).toEqual({ added: 4, removed: 2 })
  })

  test("handles escaped quotes inside string values", () => {
    const raw = `{"oldString": "he said \\"hello\\"\\nworld", "newString": "bye"}`
    expect(countStreamedEditLines(raw)).toEqual({ added: 1, removed: 2 })
  })

  test("handles escaped backslashes", () => {
    const raw = `{"oldString": "a\\\\b\\nc", "newString": "x"}`
    expect(countStreamedEditLines(raw)).toEqual({ added: 1, removed: 2 })
  })

  test("escaped backslash before n is not a newline", () => {
    const raw = `{"oldString": "a\\\\nb", "newString": "x"}`
    expect(countStreamedEditLines(raw)).toEqual({ added: 1, removed: 1 })
  })

  test("handles new file creation (no oldString)", () => {
    const raw = `{"filePath": "/p.ts", "oldString": "", "newString": "line1\\nline2\\nline3"}`
    expect(countStreamedEditLines(raw)).toEqual({ added: 3, removed: 0 })
  })

  test("handles single-line strings", () => {
    const raw = `{"oldString": "single", "newString": "single replacement"}`
    expect(countStreamedEditLines(raw)).toEqual({ added: 1, removed: 1 })
  })

  test("handles keys with extra whitespace", () => {
    const raw = `{ "oldString" : "a\\nb" , "newString" : "a\\nb\\nc" }`
    expect(countStreamedEditLines(raw)).toEqual({ added: 3, removed: 2 })
  })

  test("handles oldString appearing after newString in JSON", () => {
    const raw = `{"newString": "x\\ny", "oldString": "z"}`
    expect(countStreamedEditLines(raw)).toEqual({ added: 2, removed: 1 })
  })

  test("handles unicode escape sequences", () => {
    const raw = `{"oldString": "\\u0041\\u0042", "newString": "\\u0043"}`
    expect(countStreamedEditLines(raw)).toEqual({ added: 1, removed: 1 })
  })

  test("counts unicode-escaped newlines in both cases", () => {
    const raw = `{"oldString": "a\\u000Ab\\u000ac", "newString": "x\\ny"}`
    expect(countStreamedEditLines(raw)).toEqual({ added: 2, removed: 3 })
  })
})

describe("countStreamedLines", () => {
  test("returns zero for empty string", () => {
    expect(countStreamedLines("", "content")).toBe(0)
  })

  test("returns zero when only filePath has streamed", () => {
    expect(countStreamedLines(`{"filePath": "/p.ts"`, "content")).toBe(0)
  })

  test("counts partial multiline content", () => {
    const raw = `{"filePath": "/p.ts", "content": "line1\\nline2\\nline3`
    expect(countStreamedLines(raw, "content")).toBe(3)
  })

  test("counts single-line content", () => {
    const raw = `{"filePath": "/p.ts", "content": "just one line"}`
    expect(countStreamedLines(raw, "content")).toBe(1)
  })

  test("escaped backslash before n is not a newline", () => {
    const raw = `{"filePath": "/p.ts", "content": "a\\\\nb`
    expect(countStreamedLines(raw, "content")).toBe(1)
  })
})
