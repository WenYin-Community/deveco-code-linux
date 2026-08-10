import { Workspace } from "@/control-plane/workspace"
import { SyncTicket } from "@/control-plane/sync-ticket"
import * as InstanceState from "@/effect/instance-state"
import { Session } from "@/session/session"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { asc } from "drizzle-orm"
import { and } from "drizzle-orm"
import { eq } from "drizzle-orm"
import { lte } from "drizzle-orm"
import { not } from "drizzle-orm"
import { or } from "drizzle-orm"
import { Effect, Scope } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { HistoryPayload, ReplayPayload, SessionPayload, SyncGuardQuery } from "../groups/sync"
import path from "path"

export const syncHandlers = HttpApiBuilder.group(InstanceHttpApi, "sync", (handlers) =>
  Effect.gen(function* () {
    const workspace = yield* Workspace.Service
    const session = yield* Session.Service
    const scope = yield* Scope.Scope
    const events = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service

    const start = Effect.fn("SyncHttpApi.start")(function* () {
      yield* workspace
        .startWorkspaceSyncing((yield* InstanceState.context).project.id)
        .pipe(Effect.ignore, Effect.forkIn(scope))
      return true
    })

    const replay = Effect.fn("SyncHttpApi.replay")(function* (ctx: {
      payload: typeof ReplayPayload.Type
      query: typeof SyncGuardQuery.Type
    }) {
      const ownerID = yield* InstanceState.workspaceID
      // B: the workspace-bound SyncTicket proves the caller is the control-plane
      // acting on this resolved workspace; basic auth alone is a shared
      // credential with no workspace identity.
      if (!SyncTicket.verify(ctx.query.ticket, ownerID)) {
        return yield* new HttpApiError.Forbidden({})
      }
      const payload: EventV2.SerializedEvent[] = ctx.payload.events.map((event) => ({
        id: event.id,
        aggregateID: event.aggregateID,
        seq: event.seq,
        type: event.type,
        data: { ...event.data },
      }))
      const source = payload[0].aggregateID
      yield* Effect.logInfo("sync replay requested", {
        sessionID: source,
        events: payload.length,
        first: payload[0]?.seq,
        last: payload.at(-1)?.seq,
        directory: path.basename(ctx.payload.directory),
      })
      yield* events.replayAll(payload, { ownerID, strictOwner: true })
      yield* Effect.logInfo("sync replay complete", {
        sessionID: source,
        events: payload.length,
        first: payload[0]?.seq,
        last: payload.at(-1)?.seq,
      })
      return { sessionID: source }
    })

    const steal = Effect.fn("SyncHttpApi.steal")(function* (ctx: {
      payload: typeof SessionPayload.Type
      query: typeof SyncGuardQuery.Type
    }) {
      const workspaceID = yield* InstanceState.workspaceID
      if (!workspaceID) return yield* new HttpApiError.BadRequest({})
      // B: workspace-bound SyncTicket — basic auth is a shared credential with
      // no workspace identity, so it cannot authorize pivoting a session into
      // a workspace by setting ?workspace= alone.
      if (!SyncTicket.verify(ctx.query.ticket, workspaceID)) {
        return yield* new HttpApiError.Forbidden({})
      }

      // C: ownership ACL — reject reassigning a session whose event aggregate
      // is already owned by another workspace. Defense in depth behind the
      // ticket: a stolen or leaked ticket still cannot move a session the
      // source workspace owns. An unowned aggregate (no replay yet) is
      // claimable, matching events.claim semantics.
      const owner = yield* db
        .select({ ownerID: EventSequenceTable.owner_id })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, ctx.payload.sessionID))
        .get()
        .pipe(Effect.orDie)
      if (owner?.ownerID && owner.ownerID !== workspaceID) {
        return yield* new HttpApiError.Forbidden({})
      }

      yield* session.setWorkspace({ sessionID: ctx.payload.sessionID, workspaceID })

      yield* Effect.logInfo("sync session stolen", { sessionID: ctx.payload.sessionID, workspaceID })

      return { sessionID: ctx.payload.sessionID }
    })

    const history = Effect.fn("SyncHttpApi.history")(function* (ctx: { payload: typeof HistoryPayload.Type }) {
      const exclude = Object.entries(ctx.payload)
      return yield* db
        .select()
        .from(EventTable)
        .where(
          exclude.length > 0
            ? not(or(...exclude.map(([id, seq]) => and(eq(EventTable.aggregate_id, id), lte(EventTable.seq, seq))))!)
            : undefined,
        )
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
    })

    return handlers.handle("start", start).handle("replay", replay).handle("steal", steal).handle("history", history)
  }),
)
