import { describe, expect, test } from "bun:test"
import { convert } from "../src/protocols/utils/gemini-tool-schema"

describe("Gemini tool schema convert", () => {
  test("projects nullable type arrays into type plus nullable", () => {
    expect(convert({ type: ["string", "null"], description: "d" })).toEqual({
      type: "string",
      nullable: true,
      description: "d",
    })
  })

  test("projects const as a single-value enum", () => {
    expect(convert({ const: "fixed" })).toEqual({ enum: ["fixed"] })
  })

  test("drops empty object schemas", () => {
    expect(convert({ type: "object", properties: {} })).toBeUndefined()
  })

  test("defaults array items without schema intent to string", () => {
    expect(convert({ type: "array", items: {} })).toEqual({ type: "array", items: { type: "string" } })
  })
})
