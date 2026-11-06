import { describe, expect, it } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { classifyFinish, hasVisibleOutput, isReasoningOnly, isTerminal } from "../../src/session/finish-outcome"

const base = {
  messageID: MessageID.ascending(),
  sessionID: SessionID.create(),
  id: PartID.ascending(),
}

function text(value: string): SessionV1.Part {
  return { ...base, type: "text", text: value }
}

function reasoning(value: string): SessionV1.Part {
  return { ...base, type: "reasoning", text: value, time: { start: 1, end: 2 } }
}

function tool(state: SessionV1.ToolPart["state"], metadata?: SessionV1.ToolPart["metadata"]): SessionV1.Part {
  return { ...base, type: "tool", callID: "call_1", tool: "edit", state, metadata }
}

const running: SessionV1.ToolPart["state"] = { status: "running", input: {}, time: { start: 1 } }
const interrupted: SessionV1.ToolPart["state"] = {
  status: "error",
  input: {},
  error: "Tool execution aborted",
  metadata: { interrupted: true },
  time: { start: 1, end: 2 },
}

function classify(input: { finish?: string; parts?: SessionV1.Part[]; retries?: number }) {
  return classifyFinish({
    finish: input.finish,
    error: undefined,
    parts: input.parts ?? [],
    retries: input.retries ?? 0,
  })
}

describe("classifyFinish", () => {
  it("treats a missing finish as an unfinished turn", () => {
    expect(classify({})).toBe("incomplete")
  })

  it("keeps running for tool-calls and for pending tools under any finish", () => {
    expect(classify({ finish: "tool-calls" })).toBe("need-tools")
    // Providers that report "stop" alongside tool calls still need the results
    // sent back, which is why the pending-tool check outranks the finish.
    expect(classify({ finish: "stop", parts: [tool(running)] })).toBe("need-tools")
    expect(classify({ finish: "unknown", parts: [tool(running)] })).toBe("need-tools")
  })

  it("does not count provider-executed or orphaned tools as pending work", () => {
    // This is the hole a bare `part.type === "tool"` check leaves: neither of
    // these is work the loop can continue from, so an unknown finish holding
    // only them is an empty turn, not a tool turn.
    expect(classify({ finish: "unknown", parts: [tool(running, { providerExecuted: true })] })).toBe(
      "empty-unknown-retry",
    )
    expect(classify({ finish: "unknown", parts: [tool(interrupted)] })).toBe("empty-unknown-retry")
  })

  it("passes terminal finishes straight through", () => {
    expect(classify({ finish: "stop" })).toBe("stop")
    expect(classify({ finish: "length" })).toBe("length")
    expect(classify({ finish: "content-filter" })).toBe("content-filter")
    expect(classify({ finish: "error" })).toBe("error")
  })

  it("reports a pre-existing error before reading the finish", () => {
    expect(
      classifyFinish({
        finish: "unknown",
        error: { name: "UnknownError", data: { message: "boom" } },
        parts: [],
        retries: 0,
      }),
    ).toBe("error")
  })

  it("treats an unknown finish that produced text as a stop", () => {
    expect(classify({ finish: "unknown", parts: [text("all done")] })).toBe("unknown-with-content")
  })

  it("retries an unknown finish that only produced reasoning", () => {
    // The 0904 task12 shape: the gateway truncated a 598s think at its 600s
    // response timeout, so the turn carried 92k characters of reasoning and no
    // text, no tool call, no file. Counting that as content exited the loop
    // reporting success for a session that built nothing.
    expect(classify({ finish: "unknown", parts: [reasoning("thinking")] })).toBe("empty-unknown-retry")
    expect(classify({ finish: "unknown", parts: [reasoning("thinking")], retries: 1 })).toBe("empty-unknown-exhausted")
    // Reasoning alongside real output is still a stop.
    expect(classify({ finish: "unknown", parts: [reasoning("thinking"), text("all done")] })).toBe(
      "unknown-with-content",
    )
  })

  it("ignores whitespace-only content when deciding whether a turn did work", () => {
    expect(classify({ finish: "unknown", parts: [text("   \n")] })).toBe("empty-unknown-retry")
  })

  it("retries an empty unknown turn once, then gives up", () => {
    expect(classify({ finish: "unknown", retries: 0 })).toBe("empty-unknown-retry")
    expect(classify({ finish: "unknown", retries: 1 })).toBe("empty-unknown-exhausted")
    expect(classify({ finish: "unknown", retries: 2 })).toBe("empty-unknown-exhausted")
  })
})

describe("hasVisibleOutput", () => {
  it("counts text but never reasoning", () => {
    expect(hasVisibleOutput([text("hi")])).toBe(true)
    expect(hasVisibleOutput([reasoning("hmm")])).toBe(false)
    expect(hasVisibleOutput([text("  ")])).toBe(false)
    expect(hasVisibleOutput([])).toBe(false)
  })
})

describe("isReasoningOnly", () => {
  it("identifies a turn that thought but never spoke or acted", () => {
    expect(isReasoningOnly([reasoning("hmm")])).toBe(true)
    expect(isReasoningOnly([reasoning("hmm"), text("done")])).toBe(false)
    expect(isReasoningOnly([reasoning("hmm"), tool(running)])).toBe(false)
    // Nothing at all is empty, not reasoning-only.
    expect(isReasoningOnly([])).toBe(false)
    expect(isReasoningOnly([reasoning("  ")])).toBe(false)
    // Orphaned interrupted tools are not pending work, so a turn holding one
    // plus reasoning still only thought.
    expect(isReasoningOnly([reasoning("hmm"), tool(interrupted)])).toBe(true)
  })
})

describe("isTerminal", () => {
  it("keeps the loop running only for outcomes that still have work", () => {
    expect(isTerminal("incomplete")).toBe(false)
    expect(isTerminal("need-tools")).toBe(false)
    expect(isTerminal("empty-unknown-retry")).toBe(false)
    expect(isTerminal("stop")).toBe(true)
    expect(isTerminal("length")).toBe(true)
    expect(isTerminal("content-filter")).toBe(true)
    expect(isTerminal("error")).toBe(true)
    expect(isTerminal("unknown-with-content")).toBe(true)
    expect(isTerminal("empty-unknown-exhausted")).toBe(true)
  })
})
