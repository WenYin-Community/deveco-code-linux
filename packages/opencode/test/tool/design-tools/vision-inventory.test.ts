import { expect, test } from "bun:test"
import {
  recognizeVisualInventory,
  type VisionModelInput,
  type VisionRequestClient,
} from "@/tool/design-tools/component-recognition/component-recognition-tool"

const input: VisionModelInput = {
  baseURL: "https://vision.example.com",
  apiKey: "api-key",
  modelName: "vision-model",
  sessionID: "session-1",
  image: "data:image/png;base64,AAA",
  requirements: "Identify UI components",
}

const evidence = {
  imagePath: "/tmp/run/source/figma/component-recognition-screenshot.png",
  imageSha256: "a".repeat(64),
  requirements: "Identify UI components",
}

const inventory = {
  components: [
    {
      name: "底部导航栏",
      visual_evidence: "三枚带图标的页签均匀分布在屏幕底部",
      component_candidates: [{ name: "HdsTabs", confidence: 0.9, reason: "页签结构带图标与文字" }],
    },
  ],
  global_observations: ["整页为单屏布局，无滚动容器"],
  uncertainties: [],
}

function clientReturning(content: string, status = 200): VisionRequestClient {
  return {
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status }),
  }
}

test("builds a schemaVersion 2 ok artifact through an injected vision client", async () => {
  const client = clientReturning(JSON.stringify(inventory))
  const artifact = await recognizeVisualInventory(
    input,
    { width: 100, height: 200 },
    evidence,
    client,
  )
  const parsed = JSON.parse(artifact)
  expect(parsed.schemaVersion).toBe(2)
  expect(parsed.status).toBe("ok")
  expect(parsed.analysis.canvas).toEqual({ width: 100, height: 200 })
  expect(parsed.analysis.visible_components[0].name).toBe("底部导航栏")
  expect(parsed.analysis.visible_components[0].component_candidates[0].name).toBe("HdsTabs")
  expect(parsed.inputs.image.path).toBe(evidence.imagePath)
  expect(parsed.inputs.requirements.text).toBe("Identify UI components")
})

test("throws a structure-invalid error for unparseable model content", async () => {
  const client = clientReturning("这不是 JSON")
  expect(
    recognizeVisualInventory(input, { width: 100, height: 200 }, evidence, client),
  ).rejects.toThrow(/structure is invalid/)
})

test("rejects dimensions beyond the canvas limit before any request", async () => {
  const client = clientReturning(JSON.stringify(inventory))
  let fetchCalls = 0
  const spying: VisionRequestClient = { fetch: async (request) => { fetchCalls++; return client.fetch(request) } }
  expect(
    recognizeVisualInventory(input, { width: 200_000, height: 200 }, evidence, spying),
  ).rejects.toThrow(/pixel limit/)
  expect(fetchCalls).toBe(0)
})

test("truncates oversized non-2xx response bodies before they reach the error message", async () => {
  const client: VisionRequestClient = {
    fetch: async () => new Response("y".repeat(600), { status: 400 }),
  }
  let message = ""
  try {
    await recognizeVisualInventory(input, { width: 100, height: 200 }, evidence, client)
  } catch (error) {
    message = error instanceof Error ? error.message : ""
  }
  expect(message).toContain("Multimodal model returned 400")
  expect(message.length).toBeLessThan(500)
})

test("retries an explicit empty inventory once and falls back to a degraded artifact", async () => {
  const empty = JSON.stringify({ components: [], global_observations: [], uncertainties: [] })
  let fetchCalls = 0
  const client: VisionRequestClient = {
    fetch: async () => {
      fetchCalls++
      return new Response(JSON.stringify({ choices: [{ message: { content: empty } }] }), { status: 200 })
    },
  }
  const artifact = await recognizeVisualInventory(input, { width: 100, height: 200 }, evidence, client)
  const parsed = JSON.parse(artifact)
  expect(parsed.schemaVersion).toBe(2)
  expect(parsed.status).toBe("degraded")
  expect(parsed.failure).toEqual({
    code: "empty_components",
    attempts: 2,
    fallbackPolicy: "ignore-visual-component-recognition",
  })
  expect(parsed.analysis).toBeNull()
  expect(parsed.producer.tool).toBe("recognize_ui_components")
  expect(fetchCalls).toBe(2)
})
