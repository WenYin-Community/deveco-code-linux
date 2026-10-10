import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Shell } from "@opencode-ai/core/shell"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Agent } from "../../src/agent/agent"
import { ShellTool } from "../../src/tool/shell"
import { Truncate } from "@/tool/truncate"
import type { Tool } from "@/tool/tool"
import { Plugin } from "../../src/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"

// Mirrors the shell tool test harness: the tool itself is real, only its instance
// dependencies are provided.
const shellLayer = Layer.mergeAll(
  CrossSpawnSpawner.defaultLayer,
  FSUtil.defaultLayer,
  Plugin.defaultLayer,
  Truncate.defaultLayer,
  Config.defaultLayer,
  Agent.defaultLayer,
  RuntimeFlags.defaultLayer,
  testInstanceStoreLayer,
)
const it = testEffect(shellLayer)

Shell.acceptable.reset()

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_cli_event_readback"),
  messageID: MessageID.make("msg_cli_event_readback"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const quote = (text: string) => `"${text}"`
const squote = (text: string) => `'${text}'`
const bin = quote(process.execPath.replaceAll("\\", "/"))
const evalarg = (text: string) => (Shell.name(Shell.acceptable()) === "cmd" ? quote(text) : squote(text))

// The proxy writes DEVECO_CODE_CLI_EVENT_FILE; the shell tool reads it back after the command
// exits. The read-back re-applies the router's counting policy (allowlisted command name, owned
// subcommand), so non-command tokens never reach telemetry.
it.live("keeps well-shaped non-build cli events in shell metadata and drops malformed lines", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const valid = JSON.stringify({ command: "docs", subcommand: "search", exitCode: 1, durationMs: 3 })
    const payload = [
      valid,
      "not json",
      JSON.stringify({ command: "", exitCode: 0, durationMs: 1 }),
      JSON.stringify({ command: "build", subcommand: 42, exitCode: 0, durationMs: 1 }),
      JSON.stringify({ command: "run", exitCode: "0", durationMs: 1 }),
      // The event file is writable by any command the shell tool runs, so unknown or path-shaped
      // "commands" must be rejected on read-back too (the router allowlist is re-applied there),
      // and a subcommand the command does not own is normalised away.
      JSON.stringify({ command: "/Users/zhuyu/private/secret-app", exitCode: 0, durationMs: 1 }),
      JSON.stringify({ command: "my-secret-project", exitCode: 0, durationMs: 1 }),
      JSON.stringify({ command: "docs", subcommand: "not-a-subcommand", exitCode: 0, durationMs: 1 }),
      "",
    ].join("\n")
    const code = `await Bun.write(process.env.DEVECO_CODE_CLI_EVENT_FILE, ${JSON.stringify(payload)})`

    const tool = yield* Effect.gen(function* () {
      const info = yield* ShellTool
      return yield* info.init()
    }).pipe(provideInstance(tmp))
    const result = yield* tool
      .execute(
        { command: `${bin} -e ${evalarg(code)}`, description: "Simulate devecocli events" },
        ctx,
      )
      .pipe(provideInstance(tmp))

    // The valid line survives. The forged `docs not-a-subcommand` line is NOT dropped outright:
    // the read-back re-resolves it, so the unknown subcommand is normalised away and only the
    // allowlisted top level is kept (consistent with the router's "degrade to top level" rule).
    expect((result.metadata as Record<string, unknown>).devecoCliEvents).toEqual([
      { command: "docs", subcommand: "search", exitCode: 1, durationMs: 3 },
      { command: "docs", exitCode: 0, durationMs: 1 },
    ])
  }),
)
