import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { MessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { MessageID, SessionID } from "../../src/session/schema"
import { Stats } from "@/stats/stats"
import { testEffect } from "../lib/effect"

const directory = "/project"
const now = Date.now()
const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate())
const yesterday = today - 86_400_000
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const sessionID = SessionID.descending("ses_stats_range")

type AssistantMessage = NonNullable<(typeof MessageTable.$inferInsert)["data"]>

function assistantMessage(created: number, input: number): AssistantMessage {
  return {
    role: "assistant",
    time: { created, completed: created + 500 },
    parentID: MessageID.ascending(),
    modelID: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make("test-provider"),
    mode: "build",
    agent: "build",
    path: { cwd: directory, root: directory },
    cost: 0.5,
    tokens: { input, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
  } as AssistantMessage
}

const database = Database.layerFromPath(":memory:")
const stats = Stats.layer.pipe(Layer.provide(database))
const it = testEffect(Layer.mergeAll(database, stats))

const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "stats",
      directory,
      title: "stats",
      version: "0.0.0-test",
      time_created: yesterday,
      time_updated: now,
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(MessageTable)
    .values([
      {
        id: MessageID.ascending(),
        session_id: sessionID,
        time_created: yesterday,
        time_updated: yesterday,
        data: assistantMessage(yesterday, 100),
      },
      {
        id: MessageID.ascending(),
        session_id: sessionID,
        time_created: now,
        time_updated: now,
        data: assistantMessage(now, 1_000),
      },
    ])
    .run()
    .pipe(Effect.orDie)
})

const usage = (days?: number) =>
  Effect.gen(function* () {
    const service = yield* Stats.Service
    return yield* service.usage({ directory, days })
  })

describe("Stats.usage daily series", () => {
  it.live("a days range only trims the per-model series; daily keeps the heatmap history", () =>
    Effect.gen(function* () {
      yield* seed
      const result = yield* usage(1)
      // The overview heatmap always renders a full year, so it needs the whole
      // daily history regardless of the selected range.
      expect(result.daily.map((entry) => entry.date)).toEqual([dayKey(yesterday), dayKey(today)])
      expect(result.models.map((model) => model.daily.map((entry) => entry.date))).toEqual([[dayKey(today)]])
    }),
  )

  it.live("without a range the daily series keeps the full history", () =>
    Effect.gen(function* () {
      yield* seed
      const result = yield* usage()
      expect(result.daily.map((entry) => entry.date)).toEqual([dayKey(yesterday), dayKey(today)])
      expect(result.models.map((model) => model.daily.map((entry) => entry.date))).toEqual([
        [dayKey(yesterday), dayKey(today)],
      ])
    }),
  )
})