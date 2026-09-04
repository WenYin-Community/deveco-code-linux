import { expect, test } from "bun:test"
import { effectiveVariant, parseModel, recentModels } from "../../src/context/local"

test("parses model IDs containing slashes", () => {
  expect(parseModel("provider/family/model")).toEqual({
    providerID: "provider",
    modelID: "family/model",
  })
})

test("moves a model to the front, deduplicates, and limits recents", () => {
  const recent = Array.from({ length: 12 }, (_, index) => ({
    providerID: "provider",
    modelID: `model-${index}`,
  }))

  expect(recentModels({ providerID: "provider", modelID: "model-5" }, recent)).toEqual([
    { providerID: "provider", modelID: "model-5" },
    ...recent.slice(0, 5),
    ...recent.slice(6, 10),
  ])
})

test("effectiveVariant falls back to the cloud default effort", () => {
  const variants = ["low", "high", "max"]
  // no selection: cloud default shows on first load
  expect(effectiveVariant({ selected: undefined, variants, defaultEffort: "high" })).toBe("high")
  // explicit selection always wins over the default
  expect(effectiveVariant({ selected: "max", variants, defaultEffort: "high" })).toBe("max")
  // no default declared (or not a variant): nothing to show
  expect(effectiveVariant({ selected: undefined, variants, defaultEffort: undefined })).toBeUndefined()
  expect(effectiveVariant({ selected: undefined, variants, defaultEffort: "ultra" })).toBeUndefined()
  // stale selection (variant disappeared) falls back to the default
  expect(effectiveVariant({ selected: "gone", variants, defaultEffort: "high" })).toBe("high")
})
