import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Logger } from "effect"
import path from "path"
import { Session } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { awaitWithTimeout } from "../lib/effect"
import { reply } from "../lib/llm-server"
import { it, providerCfg, useServerConfig, deferredAsPromise } from "../fixture/session-prompt"

const captureLogs = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const records: Array<{ message: unknown; annotations: Record<string, unknown>; level: string }> = []
    const logger = Logger.make((options) => {
      const message = Array.isArray(options.message) ? options.message[0] : options.message
      const annotations = Array.isArray(options.message) ? options.message[1] : undefined
      records.push({
        message,
        annotations: (annotations ?? {}) as Record<string, unknown>,
        level: options.logLevel,
      })
    })
    yield* effect.pipe(Effect.provide(Logger.layer([logger])))
    return records
  })

for (const mode of [
  "text",
  "twice",
  "twice-text",
  "step-limit",
  "tool",
  "compaction",
  "error",
  "new-input",
  "structured",
] as const) {
  it.instance(`output length recovery: ${mode}`, () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        ...(mode === "step-limit" ? { agent: { build: { steps: 1 } } } : {}),
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const events = yield* EventV2Bridge.Service
      const seen: { type: string; data: unknown }[] = []
      const off = yield* events.listen((event) =>
        Effect.sync(() => {
          seen.push({ type: event.type, data: event.data })
        }),
      )
      yield* Effect.addFinalizer(() => off)
      const chat = yield* sessions.create({
        title: "Length regression",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      if (mode === "tool")
        yield* Effect.promise(() =>
          Bun.write(
            path.join(dir, "length-side-effect.ts"),
            "import { appendFileSync } from 'node:fs'\nappendFileSync('length-counter', 'executed sentinel\\n')\nconsole.log('tool result sentinel')\n",
          ),
        )
      yield* llm.push(
        mode === "tool"
          ? reply()
              .tool("bash", {
                command: "bun ./length-side-effect.ts",
                description: "Record test side effect",
              })
              .length()
          : reply()
              .reason("reasoning sentinel")
              .text(mode === "text" || mode === "twice-text" ? "partial text sentinel" : "")
              .usage({ input: mode === "compaction" ? 99000 : 20, output: 32000 })
              .length(),
      )
      if (mode === "compaction")
        yield* llm.push(reply().text("checkpoint sentinel").usage({ input: 20, output: 10 }).stop())
      if (mode !== "step-limit") {
        if (mode === "error") yield* llm.error(400, { error: { message: "invalid recovery request" } })
        else
          yield* llm.push(
            mode === "twice-text"
              ? reply().text("second partial text").usage({ input: 30, output: 32000 }).length()
              : mode === "twice" || mode === "compaction" || mode === "new-input"
                ? reply().reason("second reasoning").usage({ input: 30, output: 32000 }).length()
                : mode === "structured"
                  ? reply().tool("StructuredOutput", { result: "done" }).stop()
                  : reply().text("done sentinel").stop(),
          )
      }
      const result = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        ...(mode === "structured"
          ? {
              format: new SessionV1.OutputFormatJsonSchema({
                type: "json_schema",
                schema: { type: "object", properties: { result: { type: "string" } }, required: ["result"] },
                retryCount: 0,
              }),
            }
          : {}),
        parts: [{ type: "text", text: "finish" }],
      })
      expect(yield* llm.calls).toBe(mode === "step-limit" ? 1 : mode === "compaction" ? 3 : 2)
      expect(yield* llm.pending).toBe(0)
      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") throw new Error("expected assistant")
      const terminal = ["twice", "twice-text", "step-limit", "compaction", "new-input"].includes(mode)
      if (terminal) {
        expect(result.info.finish).toBe("length")
        expect(result.info.error).toMatchObject({
          name: "MessageOutputLengthError",
          data: {
            type: "output_length",
            attempts: mode === "step-limit" ? 0 : 1,
            cause: mode === "twice-text" ? "output_limit" : "reasoning_limit",
          },
        })
        expect(result.info.tokens.output).toBe(32000)
        expect((yield* prompt.loop({ sessionID: chat.id })).info.id).toBe(result.info.id)
        expect(yield* llm.calls).toBe(mode === "step-limit" ? 1 : mode === "compaction" ? 3 : 2)
      } else if (mode === "error") {
        expect(result.info.error?.name).toBe("APIError")
      } else {
        expect(result.info.error).toBeUndefined()
        if (mode === "structured") expect(result.info.structured).toEqual({ result: "done" })
      }
      const inputs = yield* llm.inputs
      if (mode !== "step-limit") {
        expect(JSON.stringify(inputs.at(-1))).toContain("previous response reached the output token limit")
        const initialMessages = (inputs[0] as { messages: unknown[] }).messages
        const recoveryMessages = (inputs.at(-1) as { messages: unknown[] }).messages
        expect(recoveryMessages.at(-1)).toMatchObject({
          role: "user",
          content: expect.stringContaining("previous response reached the output token limit"),
        })
        expect(JSON.stringify(recoveryMessages.slice(0, -1))).not.toContain(
          "previous response reached the output token limit",
        )
        if (mode !== "compaction") {
          expect(recoveryMessages.slice(0, initialMessages.length)).toEqual(initialMessages)
        }
        if (mode === "text") expect(JSON.stringify(inputs[1])).toContain("partial text sentinel")
        if (mode === "tool") expect(JSON.stringify(inputs[1].messages)).toContain("tool result sentinel")
        if (mode === "compaction") {
          expect(JSON.stringify(inputs[1])).not.toContain("previous response reached the output token limit")
          expect(JSON.stringify(inputs[2])).toContain("checkpoint sentinel")
        }
      }
      const history = yield* sessions.messages({ sessionID: chat.id })
      const truncated = history.filter((m) => m.info.role === "assistant" && m.info.finish === "length")
      expect(truncated.length).toBe(
        mode === "twice" || mode === "twice-text" || mode === "compaction" || mode === "new-input" ? 2 : 1,
      )
      expect(truncated[0].parts.some((p) => p.type === "step-finish" && p.reason === "length")).toBe(true)
      if (mode === "tool") {
        const tools = history.flatMap((m) => m.parts).filter((p) => p.type === "tool")
        expect(tools).toHaveLength(1)
        expect(tools[0]).toMatchObject({ state: { status: "completed" } })
        expect(yield* Effect.promise(() => Bun.file(path.join(dir, "length-counter")).text())).toBe(
          "executed sentinel\n",
        )
      } else {
        expect(truncated[0].parts.some((p) => p.type === "reasoning" && p.text === "reasoning sentinel")).toBe(true)
      }
      const retries = seen.filter((event) => event.type === "session.next.retried")
      expect(retries).toHaveLength(mode === "step-limit" ? 0 : 1)
      if (mode !== "step-limit")
        expect(retries[0].data).toMatchObject({ attempt: 1, error: { metadata: { reason: "output_length" } } })
      const failures = seen.filter((event) => event.type === "session.next.step.failed")
      if (terminal) {
        expect(failures).toHaveLength(1)
        expect(failures[0].data).toMatchObject({ error: { type: "output_length" } })
        const failure = failures[0].data as { assistantMessageID: string }
        const ended = seen.findIndex(
          (event) =>
            event.type === "session.next.step.ended" &&
            (event.data as { assistantMessageID: string }).assistantMessageID === failure.assistantMessageID,
        )
        expect(ended).toBeGreaterThanOrEqual(0)
        expect(ended).toBeLessThan(seen.indexOf(failures[0]))
      }
      if (mode === "new-input") {
        yield* llm.push(reply().reason("new reasoning").length(), reply().text("new done").stop())
        const next = yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [{ type: "text", text: "new activity" }],
        })
        expect(yield* llm.calls).toBe(4)
        expect(next.info.role === "assistant" && next.info.error).toBeUndefined()
        expect(seen.filter((event) => event.type === "session.next.retried")).toHaveLength(2)
      }
    }),
  )
}

for (const first of ["output_length", "empty_unknown"] as const) {
  it.instance(`turn recovery shares one activity quota after ${first}`, () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const events = yield* EventV2Bridge.Service
      const seen: { type: string; data: unknown }[] = []
      const off = yield* events.listen((event) =>
        Effect.sync(() => {
          seen.push({ type: event.type, data: event.data })
        }),
      )
      yield* Effect.addFinalizer(() => off)
      const chat = yield* sessions.create({ title: "Shared recovery quota" })
      yield* llm.push(
        first === "output_length" ? reply().reason("partial").length() : reply().unknownFinish(),
        first === "output_length" ? reply().unknownFinish() : reply().reason("partial").length(),
      )

      const result = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        parts: [{ type: "text", text: "finish" }],
      })

      expect(yield* llm.calls).toBe(2)
      expect(yield* llm.pending).toBe(0)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.info.error?.name).toBe(
          first === "output_length" ? "EmptyCompletionError" : "MessageOutputLengthError",
        )
        expect(result.info.error).toMatchObject({
          data:
            first === "empty_unknown"
              ? { type: "output_length", attempts: 1, cause: "reasoning_limit" }
              : { type: "empty_unknown", attempts: 1, cause: "response_interrupted" },
        })
      }
      const retries = seen.filter((event) => event.type === "session.next.retried")
      expect(retries).toHaveLength(1)
      expect(retries[0].data).toMatchObject({ attempt: 1, error: { metadata: { reason: first } } })
      expect(JSON.stringify((yield* llm.inputs)[1].messages)).toContain(
        first === "output_length"
          ? "previous response reached the output token limit"
          : "previous response ended before producing usable output",
      )
    }),
  )
}

it.instance("output length recovery: newly admitted input resets quota in an active loop", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), agent: { build: { steps: 2 } } }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Length steering" })
    const gate = yield* Deferred.make<void>()
    yield* llm.push(reply().reason("first activity").length())
    yield* llm.hold("first recovered", deferredAsPromise(gate))
    yield* llm.push(reply().reason("next activity").length(), reply().text("second recovered").stop())
    const fiber = yield* prompt
      .prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "first task" }] })
      .pipe(Effect.forkChild)
    yield* awaitWithTimeout(llm.wait(2), "first recovery never started")
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "next task" }],
    })
    yield* Deferred.succeed(gate, undefined)
    yield* Fiber.join(fiber)
    expect(yield* llm.calls).toBe(4)
    expect(yield* llm.pending).toBe(0)
    const inputs = yield* llm.inputs
    expect(JSON.stringify(inputs[2].messages)).not.toContain("previous response reached the output token limit")
    expect(JSON.stringify(inputs[3].messages)).toContain("previous response reached the output token limit")
    const assistants = (yield* sessions.messages({ sessionID: chat.id })).filter(
      (message) => message.info.role === "assistant",
    )
    expect(assistants).toHaveLength(4)
    expect(assistants.every((message) => message.info.role === "assistant" && !message.info.error)).toBe(true)
  }),
)

it.instance("output length recovery: interruption stops without another request", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Length interrupt" })
    yield* llm.push(reply().reason("partial").length(), reply().reason("recovering").hang())
    const fiber = yield* prompt
      .prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "finish" }] })
      .pipe(Effect.forkChild)
    yield* awaitWithTimeout(llm.wait(2), "recovery never started")
    yield* prompt.cancel(chat.id)
    yield* Fiber.await(fiber)
    expect(yield* llm.calls).toBe(2)
    const history = yield* sessions.messages({ sessionID: chat.id })
    const last = history.at(-1)
    expect(last?.info.role === "assistant" && last.info.error?.name).toBe("MessageAbortedError")
  }),
)

for (const overflow of [false, true]) {
  it.instance(
    `output length recovery: ${overflow ? "provider overflow rebuild" : "compaction with two-step budget"}`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig((url) => ({
          ...providerCfg(url),
          ...(!overflow ? { agent: { build: { steps: 2 } } } : {}),
        }))
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Length compaction" })
        yield* llm.push(
          reply()
            .reason("partial")
            .usage({ input: overflow ? 20 : 99000, output: 32000 })
            .length(),
        )
        if (overflow) yield* llm.error(400, { error: { message: "maximum context length exceeded" } })
        yield* llm.push(
          reply().text("checkpoint").usage({ input: 20, output: 10 }).stop(),
          reply().reason("again").length(),
        )
        const result = yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [{ type: "text", text: "finish" }],
        })
        expect(yield* llm.calls).toBe(overflow ? 4 : 3)
        expect(yield* llm.pending).toBe(0)
        expect(result.info.role === "assistant" && result.info.error).toMatchObject({
          name: "MessageOutputLengthError",
          data: { attempts: 1 },
        })
        const recoveryMessages = ((yield* llm.inputs).at(-1) as { messages: unknown[] }).messages
        expect(JSON.stringify(recoveryMessages)).toContain("previous response reached the output token limit")
        expect(recoveryMessages.at(-1)).toMatchObject({
          role: "user",
          content: expect.stringContaining("previous response reached the output token limit"),
        })
      }),
  )
}

it.instance("output length recovery: truncated compaction is not a valid checkpoint", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Length checkpoint" })
    yield* llm.push(
      reply().reason("partial").usage({ input: 99000, output: 32000 }).length(),
      reply().text("partial checkpoint").length(),
    )
    const result = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      parts: [{ type: "text", text: "finish" }],
    })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role === "assistant" && result.info.error?.name).toBe("MessageOutputLengthError")
    expect(result.info.role === "assistant" && result.info.finish).toBe("length")
  }),
)

it.instance("output length recovery: incomplete tool input is not executed and can be retried", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Length partial tool",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* Effect.promise(() =>
      Bun.write(
        path.join(dir, "tool-side-effect.ts"),
        "import { appendFileSync } from 'node:fs'\nappendFileSync('tool-counter', 'once\\n')\n",
      ),
    )
    const input = { command: "bun ./tool-side-effect.ts", description: "Record test side effect" }
    yield* llm.push(
      reply().pendingTool("bash", input).length(),
      reply().tool("bash", input),
      reply().text("done").stop(),
    )
    const result = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      parts: [{ type: "text", text: "finish" }],
    })
    expect(yield* llm.calls).toBe(3)
    expect(result.info.role === "assistant" && result.info.error).toBeUndefined()
    expect(yield* Effect.promise(() => Bun.file(path.join(dir, "tool-counter")).text())).toBe("once\n")
    const tools = (yield* sessions.messages({ sessionID: chat.id }))
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool")
    expect(tools).toHaveLength(2)
    expect(tools.filter((part) => part.tool === "invalid")).toHaveLength(1)
    expect(tools.filter((part) => part.tool === "bash")).toHaveLength(1)
    expect(tools.find((part) => part.tool === "bash")?.state.status).toBe("completed")
  }),
)

it.instance("loop retries a single empty unknown turn", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    // The 0903-1 task13 shape: a turn that stops mid-thought without saying why.
    // One retry is allowed because an empty turn is a provider glitch.
    yield* llm.push(reply().unknownFinish())
    yield* llm.text("recovered")

    const result = yield* prompt.loop({ sessionID: chat.id })

    expect(yield* llm.hits).toHaveLength(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") expect(result.info.error).toBeUndefined()
    expect(result.parts).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text", text: "recovered" })]))
  }),
)

it.instance("loop does not send the retried empty turn back to the model", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().unknownFinish())
    yield* llm.text("recovered")

    yield* prompt.loop({ sessionID: chat.id })

    // The empty turn is deliberately left unmarked so it stays in the export,
    // so nothing but MessageV2's own part filters keeps it out of the request.
    // An empty assistant message between two user turns is invalid for most
    // chat APIs, so lock the behaviour here.
    const inputs = yield* llm.inputs
    expect(inputs).toHaveLength(2)
    const messages = (inputs.at(-1)?.messages ?? []) as Array<{ role: string; content: unknown }>
    expect(messages.some((msg) => msg.role === "assistant")).toBe(false)
    expect(JSON.stringify(messages)).toContain("previous response ended before producing usable output")
  }),
)

it.instance("loop surfaces two consecutive empty unknown turns as a session error", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const events = yield* EventV2Bridge.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const errors: NonNullable<SessionV1.Assistant["error"]>[] = []
    const off = yield* events.listen((event) => {
      if (event.type !== Session.Event.Error.type) return Effect.void
      const data = event.data as typeof Session.Event.Error.data.Type
      if (data.sessionID === chat.id && data.error) errors.push(data.error)
      return Effect.void
    })

    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().unknownFinish())
    yield* llm.push(reply().unknownFinish())

    const result = yield* prompt.loop({ sessionID: chat.id })
    const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: result.info.id })
    yield* off

    // The retry budget is one: two empty turns must fail rather than spin.
    expect(yield* llm.hits).toHaveLength(2)
    expect(result.info.role).toBe("assistant")
    expect(stored.info.role).toBe("assistant")
    if (result.info.role === "assistant" && stored.info.role === "assistant") {
      const expected = {
        name: "EmptyCompletionError",
        data: {
          message:
            'The model response ended unexpectedly after one automatic recovery. Send "continue" to retry from the current progress.',
          type: "empty_unknown",
          attempts: 1,
          cause: "response_interrupted",
          providerFinishReason: result.info.providerFinishReason,
        },
      } satisfies NonNullable<SessionV1.Assistant["error"]>
      expect(result.info.finish).toBe("unknown")
      // The gateway's own wording, carried through the AI SDK's rawFinishReason.
      // This used to read "other" - the SDK's normalized word - which made a
      // gateway with unusual vocabulary indistinguishable from a stream that
      // ended without sending a finish_reason at all. "other" now means only
      // the latter.
      expect(result.info.providerFinishReason).toBe("surprise")
      expect(result.info.error).toEqual(expected)
      expect(stored.info.error).toEqual(result.info.error)
      expect(errors).toContainEqual(expected)
    }
  }),
)

it.instance("distinguishes a truncated stream from a gateway's own odd wording", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service

    // A stream that ends without ever sending a finish_reason. The AI SDK falls
    // back to its seeded "other" and leaves rawFinishReason undefined, so
    // "other" is now a positive signal: the provider told us nothing.
    const cut = yield* sessions.create({ title: "Pinned" })
    yield* prompt.prompt({
      sessionID: cut.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().reason("thinking").truncated())
    yield* llm.push(reply().reason("thinking").truncated())
    const truncated = yield* prompt.loop({ sessionID: cut.id })

    // A gateway that did send a reason, just not one the SDK recognizes. Its
    // wording has to survive, or this is indistinguishable from the case above.
    const odd = yield* sessions.create({ title: "Pinned" })
    yield* prompt.prompt({
      sessionID: odd.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().reason("thinking").unknownFinish())
    yield* llm.push(reply().reason("thinking").unknownFinish())
    const spoken = yield* prompt.loop({ sessionID: odd.id })

    expect(truncated.info.role).toBe("assistant")
    expect(spoken.info.role).toBe("assistant")
    if (truncated.info.role === "assistant" && spoken.info.role === "assistant") {
      expect(truncated.info.finish).toBe("unknown")
      expect(spoken.info.finish).toBe("unknown")
      expect(truncated.info.providerFinishReason).toBe("other")
      expect(spoken.info.providerFinishReason).toBe("surprise")
    }
  }),
)

it.instance("loop treats an unknown finish with text as a stop", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    // A gateway that answers fully but reports a non-standard finish reason must
    // not be punished for it: the turn did the work.
    yield* llm.push(reply().text("all done").unknownFinish())

    const result = yield* prompt.loop({ sessionID: chat.id })

    expect(yield* llm.hits).toHaveLength(1)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.finish).toBe("unknown")
      expect(result.info.error).toBeUndefined()
    }
    expect(result.parts).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text", text: "all done" })]))
  }),
)

it.instance("loop retries an unknown finish that only produced reasoning", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    // The 0904 task12 shape: the model thought for 598s and the gateway cut the
    // stream at its 600s timeout, so the turn carried reasoning and nothing
    // else. Reasoning is the model talking to itself - it answered nothing,
    // edited nothing, called nothing - so this is a truncated turn to retry,
    // not a stop to exit on.
    yield* llm.push(reply().reason("thinking about which approach to take").unknownFinish())
    yield* llm.text("recovered")

    const result = yield* prompt.loop({ sessionID: chat.id })

    expect(yield* llm.hits).toHaveLength(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") expect(result.info.error).toBeUndefined()
    expect(result.parts).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text", text: "recovered" })]))
  }),
)

it.instance("loop surfaces two consecutive reasoning-only turns as a truncation error", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().reason("still thinking").unknownFinish())
    yield* llm.push(reply().reason("still thinking").unknownFinish())

    const result = yield* prompt.loop({ sessionID: chat.id })

    expect(yield* llm.hits).toHaveLength(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      // An unknown finish is an interrupted response even when reasoning was
      // streamed. Only an explicit length finish proves the output limit was hit.
      expect(result.info.error).toEqual({
        name: "EmptyCompletionError",
        data: {
          message:
            'The model response ended unexpectedly after one automatic recovery. Send "continue" to retry from the current progress.',
          type: "empty_unknown",
          attempts: 1,
          cause: "response_interrupted",
          providerFinishReason: result.info.providerFinishReason,
        },
      })
    }
  }),
)

it.instance("loop keeps running when an unknown finish still produced a tool call", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    // Providers that report an unrecognized finish reason alongside real tool
    // calls must not be treated as an empty turn: the work has to continue so
    // the tool result gets back to the model.
    yield* llm.push(reply().tool("todowrite", { todos: [] }).unknownFinish())
    yield* llm.text("done")

    const result = yield* prompt.loop({ sessionID: chat.id })

    expect(yield* llm.hits).toHaveLength(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.error).toBeUndefined()
    }
    expect(result.parts).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text", text: "done" })]))
  }),
)

it.instance("warns once with the raw reason when a finish maps to unknown", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().text("all done").unknownFinish())

    const logs = yield* captureLogs(prompt.loop({ sessionID: chat.id }))

    const mapped = logs.filter((entry) => entry.message === "finish reason mapped")
    expect(mapped).toHaveLength(1)
    // Whatever the gateway said, an "unknown" must arrive with evidence attached.
    expect(mapped[0]?.annotations).toMatchObject({ raw: "surprise", mapped: "unknown" })
    expect(mapped[0]?.level).toBe("Warn")
  }),
)

it.instance("stays silent on finishes that map cleanly", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    // A tool turn followed by a plain stop: two step-finishes, both recognized.
    // Neither may warn, or the diagnostic drowns in ordinary traffic.
    yield* llm.push(reply().tool("todowrite", { todos: [] }).toolCalls())
    yield* llm.text("done")

    const logs = yield* captureLogs(prompt.loop({ sessionID: chat.id }))

    expect(logs.filter((entry) => entry.message === "finish reason mapped")).toEqual([])
  }),
)
