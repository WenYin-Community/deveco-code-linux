import { describe, expect, test } from "bun:test"
import { normalizeCustomProviderID, providerOptions } from "../../../../src/component/dialog-provider"

describe("providerOptions", () => {
  test("includes a synthetic Other option for custom providers", () => {
    expect(providerOptions([{ id: "openai", name: "OpenAI" }]).at(-1)).toMatchObject({
      title: "Other",
      description: "Custom provider",
      category: "Providers",
    })
  })

  test("does not use Other as the generic provider category", () => {
    expect(providerOptions([{ id: "mistral", name: "Mistral" }])[0]?.category).toBe("Providers")
  })

  test("keeps popular providers first and sorts the rest alphabetically", () => {
    expect(
      providerOptions([
        { id: "openai", name: "OpenAI" },
        { id: "minimax-cn", name: "MiniMax (minimax.cn)" },
        { id: "custom-z", name: "Zebra Provider" },
        { id: "zhipuai", name: "Zhipu AI" },
        { id: "deepseek", name: "DeepSeek" },
        { id: "moonshotai-cn", name: "Moonshot AI (China)" },
        { id: "alibaba-cn", name: "Alibaba (China)" },
        { id: "mistral", name: "Mistral" },
        { id: "aws", name: "AWS Bedrock" },
      ]).map((option) => option.value),
    ).toEqual([
      "zhipuai",
      "deepseek",
      "alibaba-cn",
      "moonshotai-cn",
      "minimax-cn",
      "aws",
      "mistral",
      "openai",
      "custom-z",
      "__opencode_custom_provider__",
    ])
  })

  test("categories only the curated popular providers as Popular", () => {
    const options = providerOptions([
      { id: "zhipuai", name: "Zhipu AI" },
      { id: "deepseek", name: "DeepSeek" },
      { id: "alibaba-cn", name: "Alibaba (China)" },
      { id: "moonshotai-cn", name: "Moonshot AI (China)" },
      { id: "minimax-cn", name: "MiniMax (minimax.cn)" },
      { id: "anthropic", name: "Anthropic" },
      { id: "openai", name: "OpenAI" },
    ])
    expect(options.filter((option) => option.category === "Popular").map((option) => option.value)).toEqual([
      "zhipuai",
      "deepseek",
      "alibaba-cn",
      "moonshotai-cn",
      "minimax-cn",
    ])
  })

  test("does not collide with a configured provider named other", () => {
    const values = providerOptions([{ id: "other", name: "Other Provider" }]).map((option) => option.value)
    expect(new Set(values).size).toBe(values.length)
  })

  test("normalizes and validates custom provider ids", () => {
    expect(normalizeCustomProviderID("  custom-provider  ")).toBe("custom-provider")
    expect(normalizeCustomProviderID("custom_provider")).toBe("custom_provider")
    expect(normalizeCustomProviderID("@ai-sdk/custom-provider")).toBe("custom-provider")
    expect(normalizeCustomProviderID("-custom-provider")).toBeUndefined()
    expect(normalizeCustomProviderID("Custom Provider")).toBeUndefined()
  })
})
