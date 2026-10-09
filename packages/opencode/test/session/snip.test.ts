   import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { shouldSnipImpl, collectEligible, SNIPPABLE_TOOLS } from "../../src/session/snip"
import { deriveShortId, SNIP_PLACEHOLDER } from "../../src/session/snip-shared"
import { turns } from "../../src/session/compaction"
import { toModelMessages } from "../../src/session/message-v2"
import type { Provider } from "@/provider/provider"
import { Schema } from "effect"

const sessionID = SessionID.make("session")
const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") }
const BIG = "x".repeat(2000)
const model: Provider.Model = {
  id: ModelV2.ID.make("test-model"),
  providerID: ref.providerID,
  api: { id: "test-model", url: "https://example.com", npm: "@ai-sdk/openai" },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 0, input: 0, output: 0 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

function basePart(messageID: string, id: string) {
  return {
    id: PartID.make(id.startsWith("prt") ? id : `prt_${id}`),
    sessionID,
    messageID: MessageID.make(messageID.startsWith("msg") ? messageID : `msg_${messageID}`),
  }
}

function mkUser(id: string, parts: SessionV1.Part[] = []): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.make(id.startsWith("msg") ? id : `msg_${id}`),
      sessionID,
      role: "user",
      time: { created: 0 },
      agent: "user",
      model: ref,
      tools: {},
      mode: "",
    } as unknown as SessionV1.User,
    parts,
  }
}

function mkAssistant(
  id: string,
  parentID: string,
  parts: SessionV1.Part[] = [],
  opts: { summary?: boolean; finish?: string; error?: SessionV1.Assistant["error"] } = {},
): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.make(id.startsWith("msg") ? id : `msg_${id}`),
      sessionID,
      role: "assistant",
      time: { created: 0 },
      error: opts.error,
      parentID: MessageID.make(parentID.startsWith("msg") ? parentID : `msg_${parentID}`),
      modelID: ref.modelID,
      providerID: ref.providerID,
      mode: "",
      agent: "agent",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      summary: opts.summary,
      finish: opts.finish,
    } as unknown as SessionV1.Assistant,
    parts,
  }
}

function mkText(messageID: string, id: string, text: string): SessionV1.Part {
  return { ...basePart(messageID, id), type: "text", text } as SessionV1.Part
}

function mkTool(
  messageID: string,
  id: string,
  tool: string,
  output: string,
  opts: { snipped?: number; compacted?: number; status?: string } = {},
): SessionV1.ToolPart {
  const status = opts.status ?? "completed"
  const state =
    status === "completed"
      ? {
          status,
          input: {},
          output,
          title: tool,
          metadata: {},
          time: { start: 0, end: 0, snipped: opts.snipped, compacted: opts.compacted },
        }
      : { status, input: {}, time: { start: 0, end: 0 } }
  return { ...basePart(messageID, id), type: "tool", callID: `call_${id}`, tool, state } as SessionV1.ToolPart
}

function mkSnipPart(
  messageID: string,
  id: string,
  opts: { snippedCount?: number; replacedCount?: number; tokensFreed?: number; snippedTurnIds?: string[]; auto?: boolean } = {},
): SessionV1.Part {
  return {
    ...basePart(messageID, id),
    type: "snip",
    snippedCount: opts.snippedCount ?? 1,
    replacedCount: opts.replacedCount ?? 1,
    tokensFreed: opts.tokensFreed ?? 100,
    snippedTurnIds: opts.snippedTurnIds ?? [],
    auto: opts.auto ?? true,
  } as SessionV1.Part
}

function cfg(snip: Record<string, unknown> = {}): ConfigV1.Info {
  return { compaction: { snip } } as unknown as ConfigV1.Info
}

describe("session.snip.snip-shared", () => {
  test("SNIP_PLACEHOLDER is the generic descriptive message", () => {
    expect(SNIP_PLACEHOLDER).toBe("该轮主要是前期探索搜索，最终信息已在后续文本中保留")
    // Must NOT echo tool names or file paths.
    expect(SNIP_PLACEHOLDER).not.toMatch(/read|grep|glob|\.ts|\.js|\/|\.\./i)
  })

  test("deriveShortId yields a deterministic 6-char base36 id", () => {
    expect(deriveShortId("msg_1")).toMatch(/^[0-9a-z]{6}$/)
    expect(deriveShortId("msg_1")).toBe(deriveShortId("msg_1"))
    expect(deriveShortId("msg_1")).not.toBe(deriveShortId("msg_2"))
  })
})

describe("session.snip.shouldSnipImpl", () => {
  test("disabled when compaction.snip.auto === false", () => {
    const messages = [
      mkUser("u1", [mkText("u1", "t", "q")]),
      mkAssistant("a1", "u1", [mkTool("a1", "t1", "read", BIG)]),
    ]
    expect(shouldSnipImpl(messages, cfg({ auto: false }))).toBe(false)
  })

  test("below threshold returns false (default threshold)", () => {
    const messages = [
      mkUser("u1", [mkText("u1", "t", "hi")]),
      mkAssistant("a1", "u1", [mkText("a1", "t", "yo")]),
    ]
    expect(shouldSnipImpl(messages, cfg())).toBe(false)
  })

  test("above threshold returns true", () => {
    const messages = [
      mkUser("u1", [mkText("u1", "t", "q")]),
      mkAssistant("a1", "u1", [mkTool("a1", "t1", "read", BIG)]),
    ]
    expect(shouldSnipImpl(messages, cfg({ threshold_tokens: 100 }))).toBe(true)
  })

  test("accumulation resets at a snip boundary user message", () => {
    // A big turn before the boundary would normally exceed the threshold, but
    // the boundary resets the accumulation so only the small post-boundary turn
    // counts → false.
    const messages = [
      mkUser("u1", [mkText("u1", "t", "q")]),
      mkAssistant("a1", "u1", [mkTool("a1", "t1", "read", BIG)]),
      mkUser("uSnip", [mkSnipPart("uSnip", "s1")]),
      mkAssistant("a2", "uSnip", [mkText("a2", "t", "small")]),
    ]
    expect(shouldSnipImpl(messages, cfg({ threshold_tokens: 100 }))).toBe(false)
  })

  test("accumulation resets at a compaction summary assistant", () => {
    const messages = [
      mkUser("u1", [mkText("u1", "t", "q")]),
      mkAssistant("a1", "u1", [mkTool("a1", "t1", "read", BIG)]),
      mkUser("u2", [mkText("u2", "t", "q")]),
      mkAssistant("a2", "u2", [mkText("a2", "t", "summary")], { summary: true, finish: "stop" }),
    ]
    expect(shouldSnipImpl(messages, cfg({ threshold_tokens: 100 }))).toBe(false)
  })
})

describe("session.snip.collectEligible", () => {
  test("protects the last N user messages from snipping", () => {
    const messages = [
      mkUser("u1", [mkText("u1", "t", "q")]),
      mkAssistant("a1", "u1", [mkTool("a1", "t1", "read", BIG)]),
      mkUser("u2", [mkText("u2", "t", "q")]),
      mkAssistant("a2", "u2", [mkTool("a2", "t2", "read", BIG)]),
      mkUser("u3", [mkText("u3", "t", "q")]),
    ]
    // tail = 1 → only u3 protected → u1 and u2 turns eligible (2 parts).
    expect(collectEligible(messages, turns(messages), 1)).toHaveLength(2)
    // tail = 3 → all user messages protected → nothing eligible.
    expect(collectEligible(messages, turns(messages), 3)).toHaveLength(0)
  })

  test("skips non-snippable tools (write/exec)", () => {
    const messages = [
      mkUser("u1", [mkText("u1", "t", "q")]),
      mkAssistant("a1", "u1", [mkTool("a1", "t1", "write", BIG)]),
    ]
    expect(SNIPPABLE_TOOLS.has("write")).toBe(false)
    expect(collectEligible(messages, turns(messages), 0)).toHaveLength(0)
  })

  test("skips already-snipped tool results", () => {
    const messages = [
      mkUser("u1", [mkText("u1", "t", "q")]),
      mkAssistant("a1", "u1", [mkTool("a1", "t1", "read", BIG, { snipped: 123 })]),
    ]
    expect(collectEligible(messages, turns(messages), 0)).toHaveLength(0)
  })

  test("skips already-compacted (pruned) tool results", () => {
    const messages = [
      mkUser("u1", [mkText("u1", "t", "q")]),
      mkAssistant("a1", "u1", [mkTool("a1", "t1", "read", BIG, { compacted: 123 })]),
    ]
    expect(collectEligible(messages, turns(messages), 0)).toHaveLength(0)
  })

  test("skips non-completed tool states (pending/error)", () => {
    const pending = [
      mkUser("u1", [mkText("u1", "t", "q")]),
      mkAssistant("a1", "u1", [mkTool("a1", "t1", "read", BIG, { status: "pending" })]),
    ]
    expect(collectEligible(pending, turns(pending), 0)).toHaveLength(0)
    const errored = [
      mkUser("u1", [mkText("u1", "t", "q")]),
      mkAssistant("a1", "u1", [mkTool("a1", "t1", "read", BIG, { status: "error" })]),
    ]
    expect(collectEligible(errored, turns(errored), 0)).toHaveLength(0)
  })

  test("collects an eligible read result tagged with the derived turn id", () => {
    const messages = [
      mkUser("u1", [mkText("u1", "t", "q")]),
      mkAssistant("a1", "u1", [mkTool("a1", "t1", "read", BIG)]),
    ]
    const eligible = collectEligible(messages, turns(messages), 0)
    expect(eligible).toHaveLength(1)
    expect(eligible[0].part.tool).toBe("read")
    expect(eligible[0].part.state.status).toBe("completed")
    expect(eligible[0].part.state.output).toBe(BIG)
    expect(eligible[0].turnId).toBe(deriveShortId("msg_u1"))
  })
})

describe("session.snip.turns-boundary-mutual-recognition", () => {
  test("turns() skips snip-boundary user messages", () => {
    const messages = [
      mkUser("u1", [mkText("u1", "t", "q1")]),
      mkAssistant("a1", "u1", [mkText("a1", "t", "a1")]),
      mkUser("uSnip", [mkSnipPart("uSnip", "s1")]),
      mkUser("u2", [mkText("u2", "t", "q2")]),
      mkAssistant("a2", "u2", [mkText("a2", "t", "a2")]),
    ]
    const result = turns(messages)
    expect(result).toHaveLength(2)
    expect(result.map((t) => t.id)).toEqual([MessageID.make("msg_u1"), MessageID.make("msg_u2")])
    expect(result[0]).toMatchObject({ start: 0, end: 3 })
    expect(result[1]).toMatchObject({ start: 3, end: 5 })
  })
})

describe("session.snip.injectMessageIds", () => {
  test("appends [turn_XXXXXX] to real user queries when injectMessageIds is true", async () => {
    const messages = [
      mkUser("u1", [mkText("u1", "t", "what files exist")]),
      mkAssistant("a1", "u1", [mkText("a1", "t", "here they are")]),
    ]
    const result = await toModelMessages(messages, model, { injectMessageIds: true })
    const userMsg = result.find((m) => m.role === "user")!
    const content = Array.isArray(userMsg.content) ? userMsg.content : []
    const lastText = [...content]
      .reverse()
      .find((p) => p.type === "text") as { type: "text"; text: string }
    expect(lastText.text).toMatch(/\n\[turn_[0-9a-z]{6}\]$/)
    expect(lastText.text).toBe(`what files exist\n[turn_${deriveShortId("msg_u1")}]`)
  })

  test("does not tag user queries when injectMessageIds is absent", async () => {
    const messages = [
      mkUser("u1", [mkText("u1", "t", "what files exist")]),
      mkAssistant("a1", "u1", [mkText("a1", "t", "here they are")]),
    ]
    const result = await toModelMessages(messages, model)
    const userMsg = result.find((m) => m.role === "user")!
    const content = Array.isArray(userMsg.content) ? userMsg.content : []
    const lastText = [...content]
      .reverse()
      .find((p) => p.type === "text") as { type: "text"; text: string }
    expect(lastText.text).toBe("what files exist")
  })
})

describe("session.snip.snip-part-content", () => {
  test("SnipPart carries the boundary summary fields", () => {
    const raw = mkSnipPart("uSnip", "s1", {
      snippedCount: 3,
      replacedCount: 7,
      tokensFreed: 1234,
      snippedTurnIds: ["abc123", "def456"],
      auto: false,
    })
    const part = Schema.decodeUnknownSync(SessionV1.SnipPart)(raw)
    expect(part.type).toBe("snip")
    expect(part.snippedCount).toBe(3)
    expect(part.replacedCount).toBe(7)
    expect(part.tokensFreed).toBe(1234)
    expect(part.snippedTurnIds).toEqual(["abc123", "def456"])
    expect(part.auto).toBe(false)
  })
})
