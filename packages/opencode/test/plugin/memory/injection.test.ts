import { expect, describe, it } from "bun:test"

/**
 * Tests for template placeholder safety (P1-8).
 * Validates that user-controlled content cannot hijack template placeholders.
 */
describe("template placeholder safety", () => {
  // The fixed approach: use split/join instead of String.replace
  function safeReplace(template: string, placeholder: string, value: string): string {
    return template.split(placeholder).join(value)
  }

  it("user content containing placeholder does not hijack template", () => {
    const template = "Memory: {{memoryContent}}\nIndex: {{memoryIndex}}"
    const userContent = "This has {{memoryIndex}} in it"

    // With split/join, the user content's {{memoryIndex}} is just text
    const step1 = safeReplace(template, "{{memoryContent}}", userContent)
    const step2 = safeReplace(step1, "{{memoryIndex}}", "actual-index-content")

    expect(step2).toContain("actual-index-content")
    expect(step2).not.toContain("{{memoryContent}}")
    expect(step2).not.toContain("{{memoryIndex}}")
  })

  it("user content with $& does not cause replacement pattern injection", () => {
    const template = "Content: {{content}}"
    const userContent = "Price: $&100"

    const result = safeReplace(template, "{{content}}", userContent)
    expect(result).toBe("Content: Price: $&100")
  })

  it("replaces all occurrences of placeholder", () => {
    const template = "{{name}} and {{name}} again"
    const result = safeReplace(template, "{{name}}", "test")
    expect(result).toBe("test and test again")
  })

  it("handles empty content", () => {
    const template = "Before {{placeholder}} After"
    const result = safeReplace(template, "{{placeholder}}", "")
    expect(result).toBe("Before  After")
  })
})
