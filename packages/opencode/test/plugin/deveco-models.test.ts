import { Global } from "@opencode-ai/core/global"
import { createHash } from "node:crypto"
import { tokenStorage } from "../../src/plugin/deveco/token-storage"
import { tmpdir } from "../fixture/fixture"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import "../../src/plugin/deveco-models"

const DEVECO_PROVIDER_ID = "deveco"

function makeApiModelConfig(m: {
  model_id: string
  thinking_mode?: string
  tool_call_mode?: string
  reasoning_effort?: string
  context_window?: number
  output?: string | number
  input_modalities?: string[]
}, id: number) {
  return {
    id,
    model_id: m.model_id,
    thinking_mode: m.thinking_mode,
    tool_call_mode: m.tool_call_mode,
    reasoning_effort: m.reasoning_effort,
    context_window: m.context_window,
    output: m.output,
    input_modalities: m.input_modalities,
  }
}

function makeValidApiResponse(overrides?: {
  code?: number
  models?: Array<{
    model_id: string
    thinking_mode?: string
    tool_call_mode?: string
    reasoning_effort?: string
    context_window?: number
    output?: string | number
    input_modalities?: string[]
  }>
  taskDefaultModelMap?: Record<string, string>
  groups?: Array<{
    protocol?: string
    group_name?: string
    group_name_cn?: string
    model_configs?: Array<{
      model_id: string
      thinking_mode?: string
      tool_call_mode?: string
      context_window?: number
      output?: string | number
      input_modalities?: string[]
    }>
    task_default_model_map?: Record<string, string>
  }>
}) {
  const code = overrides?.code ?? 200
  if (overrides?.groups) {
    return {
      code,
      body: {
        version: 1,
        inner_models: overrides.groups.map((g, gi) => ({
          protocol: g.protocol ?? "openai",
          group_name: g.group_name ?? `group-${gi}`,
          ...(g.group_name_cn ? { group_name_cn: g.group_name_cn } : {}),
          model_configs: (g.model_configs ?? []).map((m, mi) => makeApiModelConfig(m, gi * 100 + mi + 1)),
          ...(g.task_default_model_map ? { task_default_model_map: g.task_default_model_map } : {}),
        })),
      },
    }
  }
  const configs = overrides?.models ?? [
    { model_id: "glm-5", thinking_mode: "on", tool_call_mode: "tool_calls", context_window: 202752, output: 131072, input_modalities: ["text"] },
  ]
  const taskMap = overrides?.taskDefaultModelMap
  return {
    code,
    body: {
      version: 1,
      inner_models: [
        {
          protocol: "openai",
          group_name: "default",
          model_configs: configs.map((m, i) => makeApiModelConfig(m, i + 1)),
          ...(taskMap ? { task_default_model_map: taskMap } : {}),
        },
      ],
    },
  }
}

function mockFetch(fn: (input: URL | RequestInfo, init?: RequestInit | BunFetchRequestInit) => Promise<Response>): typeof globalThis.fetch {
  return fn as typeof globalThis.fetch
}

let freshModule: typeof import("../../src/plugin/deveco-models")
let testCounter = 0

async function loadFresh() {
  mock.module("@/effect/app-runtime", () => ({
    AppRuntime: { runPromise: async () => {}, dispose: async () => {} },
  }))
  freshModule = (await import(`../../src/plugin/deveco-models?fresh=${++testCounter}`)) as typeof freshModule
  return freshModule
}

describe("getDevecoProviderConfig", () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("a corrupt disk cache cannot relabel the previous account's memory cache", async () => {
    await using tmp = await tmpdir()
    const cache = Global.Path.cache
    Global.Path.cache = tmp.path
    try {
      const mod = await loadFresh()
      globalThis.fetch = mockFetch(async () => Response.json(makeValidApiResponse()))
      expect(await mod.getDevEcoModelCatalog("old-access")).not.toBeNull()
      const owner = createHash("sha256").update((await tokenStorage.loadToken()) ?? "new-access").digest("hex")
      await Bun.write(`${tmp.path}/deveco-models-${owner}.json`, JSON.stringify({ invalid: true }))
      expect(await mod.getDevecoProviderConfig("new-access", { cachedOnly: true })).toBeNull()
      globalThis.fetch = mockFetch(async () => new Response("unavailable", { status: 503 }))
      // A poisoned cache would return the old catalog without contacting the server.
      expect(await mod.getDevEcoModelCatalog("new-access")).toBeNull()
    } finally {
      Global.Path.cache = cache
    }
  })

  test("returns null on HTTP error", async () => {
    const mod = await loadFresh()
    globalThis.fetch = mockFetch(async () => new Response("error", { status: 500 }))
    const result = await mod.getDevecoProviderConfig("token")
    expect(result).toBeNull()
  })

  test("returns null on empty API models", async () => {
    const mod = await loadFresh()
    globalThis.fetch = mockFetch(async () =>
      Response.json({ code: 200, body: { version: 1, inner_models: [] } })
    )
    const result = await mod.getDevecoProviderConfig("token")
    expect(result).toBeNull()
  })

  test("returns null on non-200 code in response body", async () => {
    const mod = await loadFresh()
    globalThis.fetch = mockFetch(async () =>
      Response.json({ code: 403, body: { version: 1, inner_models: [] } })
    )
    const result = await mod.getDevecoProviderConfig("token")
    expect(result).toBeNull()
  })

  test("returns null on network error (fetch throws)", async () => {
    const mod = await loadFresh()
    globalThis.fetch = mockFetch(async () => { throw new Error("ECONNREFUSED") })
    const result = await mod.getDevecoProviderConfig("token")
    expect(result).toBeNull()
  })

  test("returns null on malformed JSON that fails schema validation", async () => {
    const mod = await loadFresh()
    globalThis.fetch = mockFetch(async () => Response.json({ unexpected: "shape" }))
    const result = await mod.getDevecoProviderConfig("token")
    expect(result).toBeNull()
  })

  test("fallback does not cache — subsequent call still fetches", async () => {
    const mod = await loadFresh()
    let callCount = 0
    globalThis.fetch = mockFetch(async () => {
      callCount++
      throw new Error("network error")
    })
    await mod.getDevecoProviderConfig("token")
    expect(callCount).toBe(1)
    await mod.getDevecoProviderConfig("token")
    expect(callCount).toBe(2)
  })

  test("maps API model configs and filters by task excluded list", async () => {
    const mod = await loadFresh()
    const apiResponse = makeValidApiResponse({
      models: [
        { model_id: "reasoning-model", thinking_mode: "on", tool_call_mode: "tool_calls", context_window: 200000, output: 8000 },
        { model_id: "basic-model", thinking_mode: "off", tool_call_mode: "auto", context_window: 4096, output: "2048" },
        { model_id: "no-thinking-no-tool", context_window: 8192 },
        { model_id: "bad-output-model", output: "not-a-number", context_window: 16384 },
        { model_id: "vl-model", input_modalities: ["text", "image"], tool_call_mode: "tool_calls" },
        { model_id: "empty-mods-model", input_modalities: [], tool_call_mode: "tool_calls" },
        { model_id: "excluded-model", tool_call_mode: "tool_calls" },
      ],
      taskDefaultModelMap: {
        small_model: "reasoning-model",
        [mod.CLOUD_EXCLUDED_KEY]: "excluded-model",
      },
    })
    globalThis.fetch = mockFetch(async () => Response.json(apiResponse))

    const result = await mod.getDevecoProviderConfig("test-token")
    expect(result).not.toBeNull()

    expect(result!.id).toBe(DEVECO_PROVIDER_ID)
    expect(result!.models["reasoning-model"]!.reasoning).toBe(true)
    expect(result!.models["reasoning-model"]!.tool_call).toBe(true)
    expect(result!.models["reasoning-model"]!.limit.context).toBe(200000)
    expect(result!.models["reasoning-model"]!.limit.output).toBe(8000)
    expect(result!.models["reasoning-model"]!.modalities!.input).toEqual(["text"])

    expect(result!.models["basic-model"]!.reasoning).toBe(false)
    expect(result!.models["basic-model"]!.tool_call).toBe(false)
    expect(result!.models["basic-model"]!.limit.output).toBe(2048)

    expect(result!.models["no-thinking-no-tool"]!.reasoning).toBe(false)
    expect(result!.models["no-thinking-no-tool"]!.tool_call).toBe(false)
    expect(result!.models["no-thinking-no-tool"]!.limit.context).toBe(8192)
    expect(result!.models["no-thinking-no-tool"]!.limit.output).toBe(8192)

    expect(result!.models["bad-output-model"]!.limit.output).toBe(8192)

    expect(result!.models["vl-model"]!.modalities!.input).toEqual(["text", "image"])
    expect(result!.models["vl-model"]!.limit.context).toBe(32768)

    expect(result!.models["empty-mods-model"]!.modalities!.input).toEqual(["text"])

    expect(Object.keys(result!.models)).not.toContain("excluded-model")
  })

  test("uses empty excluded list when API has no taskDefaultModelMap (no models filtered)", async () => {
    const mod = await loadFresh()
    const apiResponse = makeValidApiResponse({
      models: [
        { model_id: "model-a", tool_call_mode: "tool_calls" },
        { model_id: "Qwen2.5-VL-72B", tool_call_mode: "tool_calls" },
      ],
    })
    globalThis.fetch = mockFetch(async () => Response.json(apiResponse))
    const result = await mod.getDevecoProviderConfig("token")
    expect(result).not.toBeNull()
    expect(result!.models["model-a"]).toBeDefined()
    expect(result!.models["Qwen2.5-VL-72B"]).toBeDefined()
  })

  test("extracts taskDefaultModelMap from non-first group", async () => {
    const mod = await loadFresh()
    const apiResponse = makeValidApiResponse({
      groups: [
        {
          group_name: "models",
          model_configs: [{ model_id: "model-x", tool_call_mode: "tool_calls" }],
        },
        {
          group_name: "tasks",
          model_configs: [],
          task_default_model_map: { small_model: "model-x", [mod.CLOUD_EXCLUDED_KEY]: "model-y" },
        },
      ],
    })
    globalThis.fetch = mockFetch(async () => Response.json(apiResponse))
    const result = await mod.getDevecoProviderConfig("token")
    expect(result).not.toBeNull()
    expect(result!.models["model-x"]).toBeDefined()
    const map = mod.getTaskDefaultModelMap()
    expect(map?.small_model).toBe("model-x")
  })

  test("caches result and skips API on subsequent calls", async () => {
    const mod = await loadFresh()
    let callCount = 0
    globalThis.fetch = mockFetch(async () => {
      callCount++
      return Response.json(makeValidApiResponse())
    })
    const first = await mod.getDevecoProviderConfig("token")
    expect(callCount).toBe(1)
    const second = await mod.getDevecoProviderConfig("token")
    expect(callCount).toBe(1)
    expect(second).toBe(first)
  })

  test("sends authorization and content-type headers", async () => {
    const mod = await loadFresh()
    let capturedHeaders: Headers | undefined
    globalThis.fetch = mockFetch(async (_input, init) => {
      capturedHeaders = new Headers(init?.headers as Record<string, string> | undefined)
      return Response.json(makeValidApiResponse())
    })
    await mod.getDevecoProviderConfig("my-token")
    expect(capturedHeaders!.get("Authorization")).toBe("Bearer my-token")
    expect(capturedHeaders!.get("Content-Type")).toBe("application/json")
  })
})

describe("getTaskDefaultModelMap", () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("returns undefined when cache is empty", async () => {
    const mod = await loadFresh()
    const map = mod.getTaskDefaultModelMap()
    expect(map).toBeUndefined()
  })

  test("returns cached map after successful API fetch", async () => {
    const mod = await loadFresh()
    globalThis.fetch = mockFetch(async () =>
      Response.json(makeValidApiResponse({
        taskDefaultModelMap: { small_model: "api-model", [mod.CLOUD_EXCLUDED_KEY]: "bad-model" },
      }))
    )
    await mod.getDevecoProviderConfig("token")
    const map = mod.getTaskDefaultModelMap()
    expect(map?.small_model).toBe("api-model")
    expect(map?.[mod.CLOUD_EXCLUDED_KEY]).toBe("bad-model")
  })
})

describe("toCatalog / catalogToProvider (pure conversion)", () => {
  test("preserves groups with names, protocols and cloud ids", async () => {
    const mod = await loadFresh()
    const catalog = mod.toCatalog(
      makeValidApiResponse({
        groups: [
          {
            group_name: "general",
            group_name_cn: "通用模型",
            protocol: "openai",
            model_configs: [{ model_id: "glm-5", thinking_mode: "on" }],
          },
          {
            group_name: "multimodal",
            group_name_cn: "多模态模型",
            model_configs: [{ model_id: "qwen-vl" }],
          },
        ],
      }),
    )
    expect(catalog.version).toBe(1)
    expect(catalog.groups).toHaveLength(2)
    const [general, multimodal] = catalog.groups
    expect(general.name).toBe("general")
    expect(general.nameCn).toBe("通用模型")
    expect(general.protocol).toBe("openai")
    expect(general.models).toHaveLength(1)
    expect(general.models[0].model.id).toBe("glm-5")
    expect(general.models[0].cloudId).toBe(1)
    expect(general.models[0].group).toBe("general")
    expect(general.models[0].groupCn).toBe("通用模型")
    expect(multimodal.models[0].cloudId).toBe(101)
  })

  test("injects group identity as model family in provider projection", async () => {
    const mod = await loadFresh()
    const catalog = mod.toCatalog(
      makeValidApiResponse({
        groups: [
          { group_name: "general", group_name_cn: "通用模型", model_configs: [{ model_id: "glm-5" }] },
          { group_name: "legacy", model_configs: [{ model_id: "old-model" }] },
        ],
      }),
    )
    const provider = mod.catalogToProvider(catalog)
    expect(provider.models["glm-5"].family).toBe("通用模型")
    expect(provider.models["old-model"].family).toBe("legacy")
  })

  test("flags excluded entries but keeps catalog intact", async () => {
    const mod = await loadFresh()
    const catalog = mod.toCatalog(
      makeValidApiResponse({
        groups: [
          {
            group_name: "g",
            model_configs: [{ model_id: "keep-model" }, { model_id: "bad-model" }],
            task_default_model_map: { small_model: "keep-model", [mod.CLOUD_EXCLUDED_KEY]: "bad-model" },
          },
        ],
      }),
    )
    const bad = catalog.groups[0].models.find((entry) => entry.model.id === "bad-model")
    expect(bad?.excluded).toBe(true)
    expect(catalog.groups[0].models).toHaveLength(2)
    expect(catalog.taskDefaultModelMap.small_model).toBe("keep-model")

    const provider = mod.catalogToProvider(catalog)
    expect(provider.models["bad-model"]).toBeUndefined()
    expect(provider.models["keep-model"]).toBeDefined()
  })

  test("later group wins on duplicate model_id in provider, catalog keeps both", async () => {
    const mod = await loadFresh()
    const catalog = mod.toCatalog(
      makeValidApiResponse({
        groups: [
          { group_name: "a", model_configs: [{ model_id: "dupe", context_window: 1111, thinking_mode: "on" }] },
          { group_name: "b", model_configs: [{ model_id: "dupe", context_window: 2222, thinking_mode: "configurable" }] },
        ],
      }),
    )
    expect(catalog.groups[0].models[0].model.limit.context).toBe(1111)
    expect(catalog.groups[1].models[0].model.limit.context).toBe(2222)
    const provider = mod.catalogToProvider(catalog)
    expect(Object.keys(provider.models)).toEqual(["dupe"])
    expect(provider.models["dupe"].limit.context).toBe(2222)
    // attached display fields must later-win together with the winning entry
    expect(provider.models["dupe"].thinking_mode).toBe("configurable")
  })

  test("projection omits display keys the cloud did not send", async () => {
    const mod = await loadFresh()
    const catalog = mod.toCatalog(
      makeValidApiResponse({
        models: [{ model_id: "bare-model", tool_call_mode: "tool_calls" }],
      }),
    )
    const provider = mod.catalogToProvider(catalog)
    const bare = provider.models["bare-model"]
    for (const key of ["thinking_mode", "reasoning_effort", "tool_choice", "tool_call_mode"]) {
      expect(key in bare).toBe(key === "tool_call_mode")
    }
  })

  test("cloud reasoning_effort tiers become switchable variants with default option", async () => {
    const mod = await loadFresh()
    const catalog = mod.toCatalog(
      makeValidApiResponse({
        models: [
          // new {level, default} form
          { model_id: "GLM-5.3", thinking_mode: "on", reasoning_effort: '{"level":["low","high","max"],"default":"high"}' },
          // rollout-era plain-array form: levels only, no default
          { model_id: "GLM-5.1", thinking_mode: "on", reasoning_effort: '["high","max"]' },
        ],
      }),
    )
    const provider = mod.catalogToProvider(catalog)
    expect(provider.models["GLM-5.3"].variants).toEqual({
      low: { reasoningEffort: "low" },
      high: { reasoningEffort: "high" },
      max: { reasoningEffort: "max" },
    })
    // cloud default rides model.options into every request until switched
    expect(provider.models["GLM-5.3"].options).toEqual({ reasoningEffort: "high" })
    // array form still yields variants but no default option
    expect(provider.models["GLM-5.1"].variants).toEqual({
      high: { reasoningEffort: "high" },
      max: { reasoningEffort: "max" },
    })
    expect(provider.models["GLM-5.1"].options).toBeUndefined()
  })

  test("default outside the level list or missing level yields no effort config", async () => {
    const mod = await loadFresh()
    const catalog = mod.toCatalog(
      makeValidApiResponse({
        models: [
          { model_id: "bad-default", thinking_mode: "on", reasoning_effort: '{"level":["low","high"],"default":"max"}' },
          { model_id: "no-level", thinking_mode: "on", reasoning_effort: '{"default":"high"}' },
        ],
      }),
    )
    const provider = mod.catalogToProvider(catalog)
    // default not in level list: levels kept, default ignored
    expect(provider.models["bad-default"].variants).toEqual({
      low: { reasoningEffort: "low" },
      high: { reasoningEffort: "high" },
    })
    expect(provider.models["bad-default"].options).toBeUndefined()
    // no level array: nothing at all
    expect(provider.models["no-level"].variants).toBeUndefined()
    expect(provider.models["no-level"].options).toBeUndefined()
  })

  test("no variants without reasoning or with malformed effort payload", async () => {
    const mod = await loadFresh()
    const catalog = mod.toCatalog(
      makeValidApiResponse({
        models: [
          // reasoning off: never expose effort variants
          { model_id: "no-think", thinking_mode: "off", reasoning_effort: '["high"]' },
          // malformed payload shapes: no variants
          { model_id: "bad-json", thinking_mode: "on", reasoning_effort: "not-json" },
          { model_id: "not-array", thinking_mode: "on", reasoning_effort: '"high"' },
          { model_id: "mixed-entries", thinking_mode: "on", reasoning_effort: '["high", 42, null]' },
        ],
      }),
    )
    const provider = mod.catalogToProvider(catalog)
    expect(provider.models["no-think"].variants).toBeUndefined()
    expect(provider.models["bad-json"].variants).toBeUndefined()
    expect(provider.models["not-array"].variants).toBeUndefined()
    // non-string entries are dropped; the remaining valid tier still works
    expect(provider.models["mixed-entries"].variants).toEqual({ high: { reasoningEffort: "high" } })
  })

  test("last group with task_default_model_map wins", async () => {
    const mod = await loadFresh()
    const catalog = mod.toCatalog(
      makeValidApiResponse({
        groups: [
          { group_name: "a", model_configs: [], task_default_model_map: { small_model: "first" } },
          { group_name: "b", model_configs: [], task_default_model_map: { small_model: "second" } },
        ],
      }),
    )
    expect(catalog.taskDefaultModelMap.small_model).toBe("second")
  })

  test("tolerates null task_default_model_map per group", async () => {
    const mod = await loadFresh()
    const catalog = mod.toCatalog({
      code: 200,
      body: {
        version: 1,
        inner_models: [
          {
            protocol: "openai",
            group_name: "a",
            model_configs: [{ id: 1, model_id: "m1" }],
            task_default_model_map: null,
          },
        ],
      },
    })
    expect(catalog.taskDefaultModelMap).toEqual({})
    expect(catalog.groups[0].models[0].model.id).toBe("m1")
  })

  test("drops unknown modality strings", async () => {
    const mod = await loadFresh()
    const catalog = mod.toCatalog(
      makeValidApiResponse({
        models: [
          { model_id: "mixed", input_modalities: ["text", "hologram"] },
          { model_id: "all-unknown", input_modalities: ["hologram"] },
        ],
      }),
    )
    expect(catalog.groups[0].models[0].model.modalities!.input).toEqual(["text"])
    expect(catalog.groups[0].models[1].model.modalities!.input).toEqual(["text"])
  })
})

describe("getDevEcoModelCatalog", () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("caches catalog and returns same reference on repeat calls", async () => {
    const mod = await loadFresh()
    let callCount = 0
    globalThis.fetch = mockFetch(async () => {
      callCount++
      return Response.json(makeValidApiResponse())
    })
    const first = await mod.getDevEcoModelCatalog("token")
    expect(callCount).toBe(1)
    const second = await mod.getDevEcoModelCatalog("token")
    expect(callCount).toBe(1)
    expect(second).toBe(first)
  })

  test("returns null on failure and does not cache", async () => {
    const mod = await loadFresh()
    let callCount = 0
    globalThis.fetch = mockFetch(async () => {
      callCount++
      return new Response("error", { status: 500 })
    })
    expect(await mod.getDevEcoModelCatalog("token")).toBeNull()
    expect(await mod.getDevEcoModelCatalog("token")).toBeNull()
    expect(callCount).toBe(2)
  })

  test("group with zero models returns null without caching", async () => {
    const mod = await loadFresh()
    let callCount = 0
    globalThis.fetch = mockFetch(async () => {
      callCount++
      return Response.json({
        code: 200,
        body: {
          version: 1,
          inner_models: [{ protocol: "openai", group_name: "g", model_configs: [] }],
        },
      })
    })
    expect(await mod.getDevEcoModelCatalog("token")).toBeNull()
    await mod.getDevEcoModelCatalog("token")
    expect(callCount).toBe(2)
  })
})

describe("entry.source preserves raw cloud fields through decode", () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("keeps declared and unknown fields verbatim", async () => {
    const mod = await loadFresh()
    globalThis.fetch = mockFetch(async () =>
      Response.json({
        code: 200,
        body: {
          version: 11,
          inner_models: [
            {
              protocol: "openai",
              group_name: "mep",
              model_configs: [
                {
                  id: 0,
                  model_id: "GLM-5.1",
                  thinking_mode: "on",
                  reasoning_effort: '["high","max"]',
                  tool_choice: "required",
                  tool_call_mode: "tool_calls",
                  future_field: "kept",
                },
              ],
            },
          ],
        },
      }),
    )
    const catalog = await mod.getDevEcoModelCatalog("token")
    expect(catalog).not.toBeNull()
    const entry = catalog!.groups[0].models[0]
    const source = entry.source as Record<string, unknown>
    expect(source.thinking_mode).toBe("on")
    expect(source.reasoning_effort).toBe('["high","max"]')
    expect(source.tool_choice).toBe("required")
    expect(source.future_field).toBe("kept")
    expect(source.id).toBe(entry.cloudId)
    expect(source.model_id).toBe(entry.model.id)

    // provider projection carries the same raw fields for display/tooling
    const provider = mod.catalogToProvider(catalog!)
    const projected = provider.models["GLM-5.1"]
    expect(projected.thinking_mode).toBe("on")
    expect(projected.reasoning_effort).toBe('["high","max"]')
    expect(projected.tool_choice).toBe("required")
    expect(projected.tool_call_mode).toBe("tool_calls")
    expect(projected.reasoning).toBe(true)
    expect(projected.tool_call).toBe(true)
    expect(entry.model.reasoning).toBe(true)
    expect(entry.model.tool_call).toBe(true)
  })

  test("keeps unknown fields after a disk cache round trip", async () => {
    await using tmp = await tmpdir()
    const cache = Global.Path.cache
    Global.Path.cache = tmp.path
    try {
      const response = {
        code: 200,
        body: {
          version: 1,
          inner_models: [{
            protocol: "openai",
            group_name: "cached",
            model_configs: [{ id: 1, model_id: "cached-model", thinking_mode: "on", future_field: "kept" }],
          }],
        },
      }
      const writer = await loadFresh()
      globalThis.fetch = mockFetch(async () => Response.json(response))
      expect(await writer.getDevecoProviderConfig("token")).not.toBeNull()

      const reader = await loadFresh()
      const provider = await reader.getDevecoProviderConfig("token", { cachedOnly: true })
      expect((provider?.models["cached-model"] as Record<string, unknown> | undefined)?.thinking_mode).toBe("on")
    } finally {
      Global.Path.cache = cache
    }
  })
})
