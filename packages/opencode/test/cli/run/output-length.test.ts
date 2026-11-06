import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"
import { reply } from "../../lib/llm-server"
import { testProviderConfig } from "../../lib/test-provider"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import path from "node:path"
import { Database } from "bun:sqlite"

describe("output length through the real CLI entrypoint", () => {
  for (const native of [false, true]) {
    for (const repeated of [false, true]) {
      cliIt.live(
        `${native ? "native" : "ai-sdk"}: ${repeated ? "fails nonzero after exactly one recovery" : "recovers reasoning-only truncation through persisted history"}`,
        ({ llm, opencode, home }) =>
          Effect.gen(function* () {
            const config = testProviderConfig(llm.url)
            const provider = native ? "opencode-length-test" : "test"
            yield* llm.push(
              reply()
                .reason("partial reasoning sentinel")
                .usage({ input: 20, output: 32000, reasoning: 31940 })
                .length(),
            )
            yield* llm.push(
              repeated ? reply().reason("still reasoning").length() : reply().text("recovered sentinel").stop(),
            )
            const result = yield* opencode.run("finish the task", {
              format: "json",
              printLogs: true,
              timeoutMs: 30_000,
              model: `${provider}/test-model`,
              extraArgs: ["--title", "length regression", "--dir", home],
              env: {
                DEVECO_EXPERIMENTAL_NATIVE_LLM: native ? "1" : "0",
                DEVECO_CONFIG_CONTENT: JSON.stringify({
                  ...config,
                  provider: {
                    [provider]: {
                      ...config.provider.test,
                      id: provider,
                      models: {
                        "test-model": {
                          ...config.provider.test.models["test-model"],
                          reasoning: true,
                          interleaved: { field: "reasoning_content" },
                        },
                      },
                    },
                  },
                }),
              },
            })
            const artifacts = process.env.DEVECO_TEST_ARTIFACTS
            const providerRequests = yield* llm.calls
            const artifact = artifacts
              ? path.join(artifacts, `length-${native ? "native" : "ai-sdk"}-${repeated ? "failure" : "success"}.json`)
              : undefined
            const evidence = {
              binary: process.env.DEVECO_TEST_BINARY ?? "bun src/index.ts",
              ...result,
              providerRequests,
            }
            if (artifact) {
              yield* Effect.promise(() =>
                Bun.write(artifact, JSON.stringify({ ...evidence, stage: "run_finished" }, null, 2)),
              )
            }
            opencode.expectExit(result, repeated ? 1 : 0)
            const inputs = yield* llm.inputs
            expect(inputs).toHaveLength(2)
            expect(yield* llm.pending).toBe(0)
            expect(JSON.stringify(inputs[0])).not.toContain("previous response reached the output token limit")
            expect(JSON.stringify(inputs[1])).toContain("previous response reached the output token limit")
            // Chat-compatible replay is required here. Native lowering has its own
            // protocol policy; both runtimes must retain reasoning in durable history.
            if (!native) expect(JSON.stringify(inputs[1].messages)).toContain("partial reasoning sentinel")
            expect(inputs[1].max_tokens).toEqual(inputs[0].max_tokens)
            expect(result.stderr).toContain("output_length")
            expect(result.stderr).toContain("legacy")
            expect(result.stderr).toContain(`llm.runtime=${native ? "native" : "ai-sdk"}`)
            expect(result.stderr).toContain("turnRecovery=v1")
            expect(result.stderr).not.toContain("partial reasoning sentinel")
            const events = opencode.parseJsonEvents(result.stdout)
            const errors = events.filter((event) => event.type === "error")
            if (repeated) {
              expect(errors).toHaveLength(1)
              expect(errors[0].error).toMatchObject({
                name: "MessageOutputLengthError",
                data: { type: "output_length", attempts: 1, cause: "reasoning_limit" },
              })
            } else {
              expect(errors).toHaveLength(0)
              expect(result.stdout).toContain("recovered sentinel")
            }
            expect(events.filter((event) => event.type === "step_finish").length).toBe(2)
            // A separate process opens the on-disk DB after the CLI exits.
            // This keeps durability assertions independent of export's startup.
            const db = yield* Effect.acquireRelease(
              Effect.sync(() => new Database(path.join(home, "deveco.db"), { readonly: true })),
              (db) => Effect.sync(() => db.close()),
            )
            const assistants = db
              .query<{ id: string; data: string }, [string]>(
                "SELECT id, data FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant' ORDER BY id",
              )
              .all(String(events[0].sessionID))
              .map((row) => ({
                info: JSON.parse(row.data) as SessionV1.Assistant,
                parts: db
                  .query<{ data: string }, [string]>("SELECT data FROM part WHERE message_id = ? ORDER BY id")
                  .all(row.id)
                  .map((part) => JSON.parse(part.data) as SessionV1.Part),
              }))
            expect(assistants).toHaveLength(2)
            expect(assistants[0].info).toMatchObject({ finish: "length", tokens: { output: 60, reasoning: 31940 } })
            expect(assistants[0].parts).toContainEqual(
              expect.objectContaining({ type: "reasoning", text: "partial reasoning sentinel" }),
            )
            expect(assistants[1].info).toMatchObject(
              repeated
                ? {
                    finish: "length",
                    error: {
                      name: "MessageOutputLengthError",
                      data: { type: "output_length", attempts: 1, cause: "reasoning_limit" },
                    },
                  }
                : { finish: "stop" },
            )
            if (!repeated) expect(assistants[1].info.error).toBeUndefined()
            if (process.env.DEVECO_TEST_EXPORT === "1") {
              const exported = yield* opencode.spawn(["export", String(events[0].sessionID), "--print-logs"], {
                timeoutMs: 30_000,
              })
              opencode.expectExit(exported, 0)
              expect(
                (JSON.parse(exported.stdout) as { messages: SessionV1.WithParts[] }).messages.filter(
                  (message) => message.info.role === "assistant",
                ),
              ).toHaveLength(2)
            }
            if (artifact)
              yield* Effect.promise(() =>
                Bun.write(artifact, JSON.stringify({ ...evidence, stage: "passed", assistants }, null, 2)),
              )
          }),
        60_000,
      )
    }
  }
})
