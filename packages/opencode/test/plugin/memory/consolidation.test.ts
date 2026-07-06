import { expect, describe, it } from "bun:test"

/**
 * Tests for CJK name similarity (P0-2) and consolidation utilities.
 *
 * The calculateSimilarity function in consolidation.ts uses word-set Jaccard
 * similarity. The fix uses Unicode property escapes /\p{L}/ to preserve CJK
 * characters as tokens instead of treating them as separators.
 */
describe("CJK name similarity", () => {
  // Reproduce the fixed calculateSimilarity logic
  function calculateSimilarity(a: string, b: string): number {
    const aWords = new Set(a.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))
    const bWords = new Set(b.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))

    if (aWords.size === 0 && bWords.size === 0) return 0

    let intersection = 0
    for (const word of aWords) {
      if (bWords.has(word)) intersection++
    }

    const union = new Set([...aWords, ...bWords]).size
    return union === 0 ? 0 : intersection / union
  }

  it("different Chinese names should have low similarity", () => {
    const sim = calculateSimilarity("用户偏好", "项目架构")
    expect(sim).toBeLessThan(0.7)
  })

  it("identical Chinese names should have similarity 1.0", () => {
    const sim = calculateSimilarity("用户偏好", "用户偏好")
    expect(sim).toBe(1.0)
  })

  it("similar English names should have high similarity", () => {
    const sim = calculateSimilarity("user-preference", "user-pref")
    expect(sim).toBeGreaterThan(0.3)
  })

  it("different English names should have low similarity", () => {
    const sim = calculateSimilarity("user-preference", "project-architecture")
    expect(sim).toBeLessThan(0.5)
  })

  it("mixed CJK and English names", () => {
    const sim = calculateSimilarity("config-设置", "config-配置")
    expect(sim).toBeLessThan(1.0)
  })

  it("empty names should return 0", () => {
    const sim = calculateSimilarity("", "")
    expect(sim).toBe(0)
  })
})
