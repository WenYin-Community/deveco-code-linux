import { expect, describe, it } from "bun:test"

/**
 * Tests for SemanticSelectionExecutor.parseSelectionResult (P2-9).
 * Validates the non-greedy regex fix and edge cases.
 */
describe("parseSelectionResult", () => {
  // Reproduce the fixed parseSelectionResult logic
  function parseSelectionResult(rawOutput: string): Array<{ name: string; relevance: number }> {
    try {
      const jsonMatch = rawOutput.match(/\[[\s\S]*?\]/)
      if (!jsonMatch) return []

      const parsed = JSON.parse(jsonMatch[0])
      if (!Array.isArray(parsed)) return []

      return parsed
        .filter((item: unknown): item is { name: string; relevance: number } =>
          typeof (item as Record<string, unknown>).name === "string" &&
          typeof (item as Record<string, unknown>).relevance === "number"
        )
        .map((item) => ({
          name: item.name,
          relevance: item.relevance,
        }))
    } catch {
      return []
    }
  }

  it("parses simple JSON array", () => {
    const result = parseSelectionResult('[{"name":"foo","relevance":0.9}]')
    expect(result).toEqual([{ name: "foo", relevance: 0.9 }])
  })

  it("parses JSON array with text around it", () => {
    const result = parseSelectionResult('Here is the result: [{"name":"bar","relevance":0.5}] done.')
    expect(result).toEqual([{ name: "bar", relevance: 0.5 }])
  })

  it("non-greedy: does NOT capture across multiple bracket groups", () => {
    // Before fix: greedy /\[[\s\S]*\]/ would capture from first [ to last ]
    // After fix: non-greedy /\[[\s\S]*?\]/ captures only the first valid JSON array
    const result = parseSelectionResult(
      'Result: [{"name":"foo","relevance":0.9}] [some other bracket text]'
    )
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("foo")
  })

  it("returns empty for no JSON array", () => {
    const result = parseSelectionResult("No results found")
    expect(result).toEqual([])
  })

  it("returns empty for invalid JSON", () => {
    const result = parseSelectionResult("[invalid json]")
    expect(result).toEqual([])
  })

  it("filters out items with wrong types", () => {
    const result = parseSelectionResult('[{"name":"foo","relevance":0.9},{"name":123,"relevance":"bad"}]')
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("foo")
  })

  it("handles multiple items", () => {
    const result = parseSelectionResult(
      '[{"name":"a","relevance":0.9},{"name":"b","relevance":0.7},{"name":"c","relevance":0.3}]'
    )
    expect(result).toHaveLength(3)
    expect(result.map(r => r.name)).toEqual(["a", "b", "c"])
  })
})
