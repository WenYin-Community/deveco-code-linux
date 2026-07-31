import { describe, expect, test } from "bun:test"
import { countStreamedEditChars } from "../../src/util/count-streamed-edit-chars"

describe("countStreamedEditChars", () => {
  test("returns zeros for empty string", () => {
    expect(countStreamedEditChars("")).toEqual({ added: 0, removed: 0 })
  })

  test("returns zeros when only filePath has streamed", () => {
    const raw = `{"filePath": "/some/path.ts"`
    expect(countStreamedEditChars(raw)).toEqual({ added: 0, removed: 0 })
  })

  test("counts partial oldString with no newString yet", () => {
    const raw = `{"filePath": "/p.ts", "oldString": "line1\\nline2\\nline3`
    expect(countStreamedEditChars(raw)).toEqual({ added: 0, removed: 19 })
  })

  test("counts complete oldString and partial newString", () => {
    const raw = `{"filePath": "/p.ts", "oldString": "line1\\nline2", "newString": "line1\\nline2\\nline3\\nline4`
    expect(countStreamedEditChars(raw)).toEqual({ added: 26, removed: 12 })
  })

  test("counts both complete oldString and newString", () => {
    const raw = `{"filePath": "/p.ts", "oldString": "a\\nb", "newString": "a\\nb\\nc\\nd"}`
    expect(countStreamedEditChars(raw)).toEqual({ added: 10, removed: 4 })
  })

  test("handles escaped quotes inside string values", () => {
    const raw = `{"oldString": "he said \\"hello\\"\\nworld", "newString": "bye"}`
    expect(countStreamedEditChars(raw)).toEqual({ added: 3, removed: 24 })
  })

  test("handles escaped backslashes", () => {
    const raw = `{"oldString": "a\\\\b\\nc", "newString": "x"}`
    expect(countStreamedEditChars(raw)).toEqual({ added: 1, removed: 7 })
  })

  test("handles new file creation (no oldString)", () => {
    const raw = `{"filePath": "/p.ts", "oldString": "", "newString": "line1\\nline2\\nline3"}`
    expect(countStreamedEditChars(raw)).toEqual({ added: 19, removed: 0 })
  })

  test("handles single-line strings", () => {
    const raw = `{"oldString": "single", "newString": "single replacement"}`
    expect(countStreamedEditChars(raw)).toEqual({ added: 18, removed: 6 })
  })

  test("handles keys with extra whitespace", () => {
    const raw = `{ "oldString" : "a\\nb" , "newString" : "a\\nb\\nc" }`
    expect(countStreamedEditChars(raw)).toEqual({ added: 7, removed: 4 })
  })

  test("handles oldString appearing after newString in JSON", () => {
    const raw = `{"newString": "x\\ny", "oldString": "z"}`
    expect(countStreamedEditChars(raw)).toEqual({ added: 4, removed: 1 })
  })
})
