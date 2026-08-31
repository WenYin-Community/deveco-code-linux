import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import type { SessionSchema } from "@opencode-ai/core/session/schema"
import { MessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { and, eq, gte, inArray, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"

export type UsageTokens = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export type ModelUsage = {
  providerID: string
  modelID: string
  messages: number
  cost: number
  tokens: UsageTokens
  daily: DailyUsage[]
}

export type SessionUsage = {
  sessionID: string
  title: string
  timeCreated: number
  model?: { providerID: string; modelID: string }
  messages: number
  cost: number
  tokens: UsageTokens
  durationApi: number
  durationWall: number
  additions: number
  deletions: number
}

export type DailyUsage = {
  date: string
  messages: number
  tokens: number
}

export type Usage = {
  directory?: string
  total: {
    sessions: number
    messages: number
    cost: number
    longestDuration: number
    tokens: UsageTokens
  }
  models: ModelUsage[]
  session?: SessionUsage
  daily: DailyUsage[]
}

export interface Interface {
  readonly usage: (input: { directory?: string; sessionID?: SessionSchema.ID; days?: number }) => Effect.Effect<Usage>
  readonly quota: () => Effect.Effect<Quota>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Stats") {}

const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000

const usageTokens = (input: number, output: number, reasoning: number, cacheRead: number, cacheWrite: number): UsageTokens => ({
  input,
  output,
  reasoning,
  cache: { read: cacheRead, write: cacheWrite },
})

const assistantRole = sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`

const tokenSum = (path: string) => sql<number>`coalesce(sum(coalesce(json_extract(${MessageTable.data}, '${sql.raw(path)}'), 0)), 0)`

export const layer: Layer.Layer<Service, never, Database.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const sessionUsage = Effect.fn("Stats.sessionUsage")(function* (sessionID: SessionSchema.ID) {
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
      if (!row) return undefined

      // Include subagent (child) sessions: aggregate messages from the main
      // session AND all sessions whose parent_id points to it.
      const childIDs = yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(eq(SessionTable.parent_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      const familyIDs = [sessionID, ...childIDs.map((child) => child.id)]

      const messages = yield* db
        .select({
          count: sql<number>`count(*)`,
          durationApi: sql<number>`coalesce(sum(json_extract(${MessageTable.data}, '$.time.completed') - json_extract(${MessageTable.data}, '$.time.created')), 0)`,
          input: sql<number>`coalesce(sum(coalesce(json_extract(${MessageTable.data}, '$.tokens.input'), 0)), 0)`,
          output: sql<number>`coalesce(sum(coalesce(json_extract(${MessageTable.data}, '$.tokens.output'), 0)), 0)`,
          reasoning: sql<number>`coalesce(sum(coalesce(json_extract(${MessageTable.data}, '$.tokens.reasoning'), 0)), 0)`,
          cacheRead: sql<number>`coalesce(sum(coalesce(json_extract(${MessageTable.data}, '$.tokens.cache.read'), 0)), 0)`,
          cacheWrite: sql<number>`coalesce(sum(coalesce(json_extract(${MessageTable.data}, '$.tokens.cache.write'), 0)), 0)`,
          cost: sql<number>`coalesce(sum(coalesce(json_extract(${MessageTable.data}, '$.cost'), 0)), 0)`,
        })
        .from(MessageTable)
        .where(
          and(
            inArray(MessageTable.session_id, familyIDs),
            assistantRole,
            sql`json_extract(${MessageTable.data}, '$.time.completed') IS NOT NULL`,
          ),
        )
        .get()
        .pipe(Effect.orDie)
      return {
        sessionID: row.id,
        title: row.title,
        timeCreated: row.time_created,
        model: row.model ? { providerID: row.model.providerID, modelID: row.model.id } : undefined,
        messages: messages?.count ?? 0,
        cost: round6(messages?.cost ?? row.cost),
        tokens: usageTokens(
          messages?.input ?? row.tokens_input,
          messages?.output ?? row.tokens_output,
          messages?.reasoning ?? row.tokens_reasoning,
          messages?.cacheRead ?? row.tokens_cache_read,
          messages?.cacheWrite ?? row.tokens_cache_write,
        ),
        durationApi: messages?.durationApi ?? 0,
        // The caller is viewing THIS session right now (sessionID = current
        // route), so the wall clock runs to the fetch time. Aggregate stats
        // (longestDuration) use time_updated instead for stable values.
        durationWall: Date.now() - row.time_created,
        additions: row.summary_additions ?? 0,
        deletions: row.summary_deletions ?? 0,
      }
    })

    const usage = Effect.fn("Stats.usage")(function* (input: {
      directory?: string
      sessionID?: SessionSchema.ID
      days?: number
    }) {
      const sessionFilter = input.directory ? eq(SessionTable.directory, input.directory) : undefined
      // Calendar-day boundary (UTC midnight) so server-side filtering matches
      // the client's rangeMeta which also counts whole calendar days.
      const since = input.days
        ? Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) -
          (input.days - 1) * 86_400_000
        : undefined
      const timeFilter = since ? gte(MessageTable.time_created, since) : undefined
      const messageFilter = and(assistantRole, sessionFilter, timeFilter)

      const sessionTotals = yield* db
        .select({
          sessions: sql<number>`count(*)`,
          longest: sql<number>`coalesce(max(${SessionTable.time_updated} - ${SessionTable.time_created}), 0)`,
        })
        .from(SessionTable)
        .where(and(sessionFilter, since ? gte(SessionTable.time_updated, since) : undefined))
        .get()
        .pipe(Effect.orDie)

      const totals = yield* db
        .select({
          messages: sql<number>`count(*)`,
          cost: sql<number>`coalesce(sum(coalesce(json_extract(${MessageTable.data}, '$.cost'), 0)), 0)`,
          input: tokenSum("$.tokens.input"),
          output: tokenSum("$.tokens.output"),
          reasoning: tokenSum("$.tokens.reasoning"),
          cacheRead: tokenSum("$.tokens.cache.read"),
          cacheWrite: tokenSum("$.tokens.cache.write"),
        })
        .from(MessageTable)
        .innerJoin(SessionTable, eq(MessageTable.session_id, SessionTable.id))
        .where(messageFilter)
        .get()
        .pipe(Effect.orDie)

      const modelRows = yield* db
        .select({
          providerID: sql<string>`json_extract(${MessageTable.data}, '$.providerID')`,
          modelID: sql<string>`json_extract(${MessageTable.data}, '$.modelID')`,
          messages: sql<number>`count(*)`,
          cost: sql<number>`coalesce(sum(coalesce(json_extract(${MessageTable.data}, '$.cost'), 0)), 0)`,
          input: tokenSum("$.tokens.input"),
          output: tokenSum("$.tokens.output"),
          reasoning: tokenSum("$.tokens.reasoning"),
          cacheRead: tokenSum("$.tokens.cache.read"),
          cacheWrite: tokenSum("$.tokens.cache.write"),
        })
        .from(MessageTable)
        .innerJoin(SessionTable, eq(MessageTable.session_id, SessionTable.id))
        .where(messageFilter)
        .groupBy(
          sql`json_extract(${MessageTable.data}, '$.providerID')`,
          sql`json_extract(${MessageTable.data}, '$.modelID')`,
        )
        .all()
        .pipe(Effect.orDie)

      const dailyRows = yield* db
        .select({
          date: sql<string>`date(${MessageTable.time_created}/1000, 'unixepoch')`,
          messages: sql<number>`count(*)`,
          tokens: sql<number>`coalesce(sum(
            coalesce(json_extract(${MessageTable.data}, '$.tokens.input'), 0) +
            coalesce(json_extract(${MessageTable.data}, '$.tokens.output'), 0) +
            coalesce(json_extract(${MessageTable.data}, '$.tokens.reasoning'), 0) +
            coalesce(json_extract(${MessageTable.data}, '$.tokens.cache.read'), 0) +
            coalesce(json_extract(${MessageTable.data}, '$.tokens.cache.write'), 0)
          ), 0)`,
        })
        .from(MessageTable)
        .innerJoin(SessionTable, eq(MessageTable.session_id, SessionTable.id))
        .where(and(assistantRole, sessionFilter))
        .groupBy(sql`1`)
        .orderBy(sql`1`)
        .all()
        .pipe(Effect.orDie)

      const modelDailyRows = yield* db
        .select({
          providerID: sql<string>`json_extract(${MessageTable.data}, '$.providerID')`,
          modelID: sql<string>`json_extract(${MessageTable.data}, '$.modelID')`,
          date: sql<string>`date(${MessageTable.time_created}/1000, 'unixepoch')`,
          tokens: sql<number>`coalesce(sum(
            coalesce(json_extract(${MessageTable.data}, '$.tokens.input'), 0) +
            coalesce(json_extract(${MessageTable.data}, '$.tokens.output'), 0) +
            coalesce(json_extract(${MessageTable.data}, '$.tokens.reasoning'), 0) +
            coalesce(json_extract(${MessageTable.data}, '$.tokens.cache.read'), 0) +
            coalesce(json_extract(${MessageTable.data}, '$.tokens.cache.write'), 0)
          ), 0)`,
        })
        .from(MessageTable)
        .innerJoin(SessionTable, eq(MessageTable.session_id, SessionTable.id))
        .where(messageFilter)
        .groupBy(
          sql`json_extract(${MessageTable.data}, '$.providerID')`,
          sql`json_extract(${MessageTable.data}, '$.modelID')`,
          sql`date(${MessageTable.time_created}/1000, 'unixepoch')`,
        )
        .all()
        .pipe(Effect.orDie)

      const models = modelRows
        .map((row) => {
          const model = {
            providerID: row.providerID,
            modelID: row.modelID,
            messages: row.messages,
            cost: round6(row.cost),
            tokens: usageTokens(row.input, row.output, row.reasoning, row.cacheRead, row.cacheWrite),
          }
          const totalTokens =
            model.tokens.input +
            model.tokens.output +
            model.tokens.reasoning +
            model.tokens.cache.read +
            model.tokens.cache.write
          const key = `${row.providerID}/${row.modelID}`
          const daily = modelDailyRows
            .filter((item) => `${item.providerID}/${item.modelID}` === key)
            .map((item) => ({ date: item.date, messages: 0, tokens: item.tokens }))
            .toSorted((a, b) => a.date.localeCompare(b.date))
          return { model, totalTokens, daily }
        })
        .toSorted((a, b) => b.totalTokens - a.totalTokens || b.model.messages - a.model.messages)
        .map((entry) => ({ ...entry.model, daily: entry.daily }))

      return {
        directory: input.directory,
        total: {
          sessions: sessionTotals?.sessions ?? 0,
          messages: totals?.messages ?? 0,
          cost: round6(totals?.cost ?? 0),
          longestDuration: sessionTotals?.longest ?? 0,
          tokens: usageTokens(
            totals?.input ?? 0,
            totals?.output ?? 0,
            totals?.reasoning ?? 0,
            totals?.cacheRead ?? 0,
            totals?.cacheWrite ?? 0,
          ),
        },
        models,
        session: input.sessionID ? yield* sessionUsage(input.sessionID) : undefined,
        daily: dailyRows,
      }
    })

    const quota = Effect.fn("Stats.quota")(function* () {
      return yield* Effect.promise(() => fetchQuota())
    })

    return Service.of({ usage, quota })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export const node = LayerNode.make(layer, [Database.node])

export * as Stats from "./stats"

export type QuotaWindow = {
  enabled: boolean
  periodHours?: number
  nextResetTime?: string
  total?: number
  used?: number
  remaining?: number
}

export type Quota = {
  hourly?: QuotaWindow
  weekly?: QuotaWindow
  monthly?: QuotaWindow
}

export interface QuotaInterface {
  readonly quota: () => Effect.Effect<Quota>
}

type RawQuotaWindow = {
  enabled: boolean
  periodHours?: number
  nextResetTime?: string
  usage?: Record<string, { total: number; used: number; remaining: number }>
}

function simplifyWindow(raw: RawQuotaWindow | undefined): QuotaWindow | undefined {
  if (!raw) return undefined
  const first = Object.values(raw.usage ?? {})[0]
  return {
    enabled: raw.enabled,
    periodHours: raw.periodHours,
    nextResetTime: raw.nextResetTime,
    total: first?.total,
    used: first?.used,
    remaining: first?.remaining,
  }
}

async function fetchQuota(): Promise<Quota> {
  const { ensureValidToken } = await import("../plugin/deveco/token-refresh")
  const { gatewayOrigin } = await import("../plugin/deveco/types")
  const token = await ensureValidToken()
  if (!token) return {}
  const chatId = crypto.randomUUID().replace(/-/g, "")
  const res = await fetch(`${gatewayOrigin}/sse/codeGenie/queryUsageQuota`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Chat-Id": chatId,
      lang: "en",
    },
    body: "{}",
  })
  const json = (await res.json()) as { data?: { userHourly?: RawQuotaWindow; userWeekly?: RawQuotaWindow; userMonthly?: RawQuotaWindow } }
  return {
    hourly: simplifyWindow(json.data?.userHourly),
    weekly: simplifyWindow(json.data?.userWeekly),
    monthly: simplifyWindow(json.data?.userMonthly),
  }
}
