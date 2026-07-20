import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"
import path from "node:path"
import { reply } from "../../lib/llm-server"

// These tests exercise Goal execution, not skill discovery. Keep the startup
// optimization local so other CLI fixtures still use their normal defaults.
const env = { DEVECO_DISABLE_DEFAULT_SKILLS: "1", DEVECO_DISABLE_EXTERNAL_SKILLS: "1" }

describe("deveco run --command goal", () => {
  cliIt.live(
    "documents Goal mode and optional budgets in run help",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["run", "--help"])
        opencode.expectExit(result, 0)
        const help = result.stderr.replace(/\s+/g, " ")
        expect(help).toContain("goal starts a local Goal loop")
        expect(result.stderr).toContain("--token-budget")
        expect(help).toContain("omitted: unlimited")
        expect(result.stderr).not.toMatch(/--goal\b/)
        expect(yield* llm.calls).toBe(0)
      }),
    30_000,
  )

  cliIt.live(
    "pauses instead of hanging when a provider content filter ends execution",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(reply().contentFilter())
        const result = yield* opencode.run("filtered goal", { command: "goal", format: "json", timeoutMs: 30_000, env })
        opencode.expectExit(result, 1)
        expect(opencode.parseJsonEvents(result.stdout).at(-1)).toMatchObject({
          type: "goal_result",
          status: "paused",
          reason: "model execution stopped before goal completion",
          exitCode: 1,
        })
      }),
    60_000,
  )

  cliIt.live(
    "combines raw positional text and stdin, and forwards files from --dir",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => Bun.write(path.join(home, "context.txt"), "snake-context-marker"))
        yield* llm.tool("update_goal", { status: "complete" })
        yield* llm.text("verified")
        const result = yield* opencode.run("implement snake", {
          command: "goal",
          format: "json",
          stdin: "verify keyboard controls\nand scoring",
          env,
          timeoutMs: 30_000,
          agent: "build",
          tokenBudget: "1.5m",
          extraArgs: ["--dir", home, "--file", "context.txt", "--"],
        })
        opencode.expectExit(result, 0)
        expect(opencode.parseJsonEvents(result.stdout).at(-1)).toMatchObject({
          type: "goal_result",
          objective: "implement snake\nverify keyboard controls\nand scoring",
          tokenBudget: 1_500_000,
        })
        expect(JSON.stringify(yield* llm.inputs)).toContain("snake-context-marker")
      }),
    60_000,
  )

  cliIt.live(
    "treats lifecycle words as literal objectives",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.tool("update_goal", { status: "complete" })
        yield* llm.text("done")
        const literal = yield* opencode.run("stop", { command: "goal", format: "json", timeoutMs: 30_000, env })
        opencode.expectExit(literal, 0)
        expect(opencode.parseJsonEvents(literal.stdout).at(-1)).toMatchObject({ objective: "stop", status: "complete" })
      }),
    60_000,
  )

  cliIt.live(
    "accepts stdin-only goals",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.tool("update_goal", { status: "complete" })
        yield* llm.text("stdin done")
        const piped = yield* opencode.run("", {
          command: "goal",
          format: "json",
          stdin: "stdin objective",
          env,
          timeoutMs: 30_000,
        })
        opencode.expectExit(piped, 0)
        expect(opencode.parseJsonEvents(piped.stdout).at(-1)).toMatchObject({
          objective: "stdin objective",
          status: "complete",
        })
      }),
    60_000,
  )

  cliIt.live(
    "continues after a natural response and waits for completion",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("first step done")
        yield* llm.tool("update_goal", { status: "complete", reason: "implementation verified" })
        yield* llm.text("all steps done")
        const result = yield* opencode.run('implement snake\nand verify "all steps"', {
          env,
          command: "goal",
          format: "json",
          timeoutMs: 30_000,
        })
        opencode.expectExit(result, 0)
        const events = opencode.parseJsonEvents(result.stdout)
        expect(events.at(-1)).toMatchObject({
          type: "goal_result",
          status: "complete",
          tokenBudget: null,
          exitCode: 0,
          objective: 'implement snake\nand verify "all steps"',
          reason: "implementation verified",
        })
        expect(result.stdout).toContain("first step done")
        expect(result.stdout).toContain("all steps done")
        const inputs = JSON.stringify(yield* llm.inputs)
        expect(inputs).toContain("Continue working toward the active goal")
        expect(yield* llm.pending).toBe(0)
        expect(yield* llm.misses).toEqual([])
      }),
    60_000,
  )

  cliIt.live(
    "pauses at the budget boundary without another provider call",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("budget consumed", { usage: { input: 900, output: 300 } })
        yield* llm.text("must not be requested")
        const result = yield* opencode.run("bounded objective", {
          env,
          command: "goal",
          tokenBudget: "1K",
          format: "json",
          timeoutMs: 30_000,
        })
        opencode.expectExit(result, 2)
        expect(opencode.parseJsonEvents(result.stdout).at(-1)).toMatchObject({
          type: "goal_result",
          status: "paused",
          usedTokens: 1200,
          tokenBudget: 1000,
          reason: "token budget exhausted",
          exitCode: 2,
        })
        expect(yield* llm.pending).toBe(1)
        expect(result.stdout).not.toContain("must not be requested")
      }),
    60_000,
  )

  cliIt.live(
    "prints a text summary with the session, status and usage",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.tool("update_goal", { status: "complete", reason: "tests passed" })
        yield* llm.text("finished")
        const result = yield* opencode.run("finish feature", {
          env,
          command: "goal",
          tokenBudget: "200k",
          timeoutMs: 30_000,
        })
        opencode.expectExit(result, 0)
        expect(result.stdout).toContain("Goal · complete")
        expect(result.stdout).toContain("/ 200000 tokens")
        expect(result.stdout).toContain("Session: ses_")
        expect(result.stdout).toContain("Reason: tests passed")
      }),
    60_000,
  )

  cliIt.live(
    "returns nonzero when the model pauses",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.tool("update_goal", { status: "paused", reason: "model cannot continue" })
        yield* llm.text("paused")
        const paused = yield* opencode.run("pause objective", {
          env,
          command: "goal",
          format: "json",
          timeoutMs: 30_000,
        })
        opencode.expectExit(paused, 1)
        expect(opencode.parseJsonEvents(paused.stdout).at(-1)).toMatchObject({
          type: "goal_result",
          status: "paused",
          reason: "model cannot continue",
          exitCode: 1,
        })
      }),
    60_000,
  )

  cliIt.live(
    "returns nonzero when the provider fails",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.error(400, { error: { message: "provider failed", type: "invalid_request_error" } })
        const failed = yield* opencode.run("fail objective", {
          env,
          command: "goal",
          format: "json",
          timeoutMs: 30_000,
        })
        opencode.expectExit(failed, 1)
        expect(opencode.parseJsonEvents(failed.stdout).at(-1)).toMatchObject({
          type: "goal_result",
          status: "paused",
          exitCode: 1,
        })
      }),
    60_000,
  )

  cliIt.live(
    "fails promptly for an unknown model",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.run("unknown model", {
          env,
          command: "goal",
          model: "test/missing",
          timeoutMs: 30_000,
        })
        opencode.expectExit(result, 1)
        expect(result.durationMs).toBeLessThan(30_000)
      }),
    45_000,
  )

  cliIt.live(
    "rejects unsupported flags and budgets before model execution",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        const cases = [
          { args: ["--token-budget", "200k"], error: "--token-budget requires --command goal" },
          { args: ["--command", "goal", "--attach", "http://localhost:4096"], error: "does not support --attach" },
          { args: ["--command", "goal", "--interactive"], error: "--interactive cannot be used with --command" },
          { args: ["--command", "goal", "--agent", "plan"], error: "requires the build agent" },
          { args: ["--command", "goal", "--token-budget", ""], error: "--token-budget must not be empty" },
          { args: ["--command", "goal", "--token-budget", "999"], error: "Invalid --token-budget" },
          { args: ["--command", "goal", "--token-budget", "1.5"], error: "Invalid --token-budget" },
          { args: ["--command", "goal", "--token-budget", "11m"], error: "Invalid --token-budget" },
          { args: ["--command", "goal", "--token-budget", "1e6"], error: "Invalid --token-budget" },
        ]
        yield* Effect.forEach(
          cases,
          (item) =>
            Effect.gen(function* () {
              const result = yield* opencode.spawn(["run", "objective", ...item.args], { env })
              opencode.expectExit(result, 1)
              expect(result.stderr).toContain(item.error)
            }),
          { concurrency: 3 },
        )
        const empty = yield* opencode.run(" ", { command: "goal", env })
        opencode.expectExit(empty, 1)
        expect(empty.stderr).toContain("requires a non-empty objective")
        expect(yield* llm.calls).toBe(0)
      }),
    90_000,
  )
})
