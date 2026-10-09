import type { McpServer } from "@agentclientprotocol/sdk"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Context, Effect, Layer, Ref } from "effect"
import * as ACPError from "./error"

export type SelectedModel = {
  providerID: ProviderV2.ID
  modelID: ModelV2.ID
}

export type KnownMessagePartMetadata = {
  messageId: string
  partId: string
  partType?: Part["type"]
  role?: Message["role"]
  ignored?: boolean
  toolCallId?: string
  metadata?: unknown
}

export type Info = {
  id: string
  cwd: string
  mcpServers: readonly McpServer[]
  createdAt: Date
  model?: SelectedModel
  variant?: string
  modeId?: string
  knownParts: ReadonlyMap<string, KnownMessagePartMetadata>
}

export type StoreInput = {
  id: string
  cwd: string
  mcpServers?: readonly McpServer[]
  createdAt?: Date
  model?: SelectedModel
  variant?: string
  modeId?: string
}

export type RecordPartMetadataInput = {
  sessionId: string
  messageId: string
  partId: string
  partType?: Part["type"]
  role?: Message["role"]
  ignored?: boolean
  toolCallId?: string
  metadata?: unknown
}

export type PartMetadataLookupInput = {
  sessionId: string
  messageId: string
  partId: string
}

export type Interface = {
  readonly create: (input: StoreInput) => Effect.Effect<Info>
  readonly load: (input: StoreInput) => Effect.Effect<Info>
  readonly list: (cwd?: string) => Effect.Effect<readonly Info[]>
  readonly get: (sessionId: string) => Effect.Effect<Info, ACPError.SessionNotFoundError>
  readonly tryGet: (sessionId: string) => Effect.Effect<Info | undefined>
  readonly remove: (sessionId: string) => Effect.Effect<Info | undefined>
  readonly setModel: (
    sessionId: string,
    model: SelectedModel | undefined,
  ) => Effect.Effect<Info, ACPError.SessionNotFoundError>
  readonly getModel: (sessionId: string) => Effect.Effect<SelectedModel | undefined, ACPError.SessionNotFoundError>
  readonly setVariant: (
    sessionId: string,
    variant: string | undefined,
  ) => Effect.Effect<Info, ACPError.SessionNotFoundError>
  readonly getVariant: (sessionId: string) => Effect.Effect<string | undefined, ACPError.SessionNotFoundError>
  readonly setMode: (
    sessionId: string,
    modeId: string | undefined,
  ) => Effect.Effect<Info, ACPError.SessionNotFoundError>
  readonly getMode: (sessionId: string) => Effect.Effect<string | undefined, ACPError.SessionNotFoundError>
  readonly recordPartMetadata: (
    input: RecordPartMetadataInput,
  ) => Effect.Effect<KnownMessagePartMetadata, ACPError.SessionNotFoundError>
  readonly getPartMetadata: (
    input: PartMetadataLookupInput,
  ) => Effect.Effect<KnownMessagePartMetadata | undefined, ACPError.SessionNotFoundError>
  readonly tryGetPartMetadata: (input: PartMetadataLookupInput) => Effect.Effect<KnownMessagePartMetadata | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ACP/Session") {}

// Stored sessions own a mutable knownParts map: recordPartMetadata and the
// part-metadata lookups fire per streamed part, and copying the map on every
// call made churn quadratic in the number of parts. Callers only ever see a
// ReadonlyMap through Info snapshots.
type StoredSession = Omit<Info, "knownParts"> & { knownParts: Map<string, KnownMessagePartMetadata> }

type State = Map<string, StoredSession>

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Ref.make<State>(new Map())

    const store = Effect.fn("ACP.Session.store")(function* (input: StoreInput) {
      const session = makeSession(input)
      yield* Ref.update(sessions, (state) => new Map(state).set(session.id, session))
      return snapshot(session)
    })

    const tryGet = Effect.fn("ACP.Session.tryGet")(function* (sessionId: string) {
      const session = (yield* Ref.get(sessions)).get(sessionId)
      if (!session) return
      return snapshot(session)
    })

    const get = Effect.fn("ACP.Session.get")(function* (sessionId: string) {
      const session = yield* tryGet(sessionId)
      if (session) return session
      return yield* new ACPError.SessionNotFoundError({ sessionId })
    })

    const update = Effect.fn("ACP.Session.update")(function* (
      sessionId: string,
      fn: (session: StoredSession) => StoredSession,
    ) {
      const result = yield* Ref.modify(sessions, (state) => {
        const session = state.get(sessionId)
        if (!session) return [undefined, state] as const
        const next = fn(session)
        return [snapshot(next), new Map(state).set(sessionId, next)] as const
      })
      if (result) return result
      return yield* new ACPError.SessionNotFoundError({ sessionId })
    })

    const remove = Effect.fn("ACP.Session.remove")(function* (sessionId: string) {
      return yield* Ref.modify(sessions, (state) => {
        const session = state.get(sessionId)
        if (!session) return [undefined, state] as const
        const next = new Map(state)
        next.delete(sessionId)
        return [snapshot(session), next] as const
      })
    })

    const setModel: Interface["setModel"] = Effect.fn("ACP.Session.setModel")((sessionId, model) =>
      update(sessionId, (session) => ({ ...session, model })),
    )

    const setVariant: Interface["setVariant"] = Effect.fn("ACP.Session.setVariant")((sessionId, variant) =>
      update(sessionId, (session) => ({ ...session, variant })),
    )

    const setMode: Interface["setMode"] = Effect.fn("ACP.Session.setMode")((sessionId, modeId) =>
      update(sessionId, (session) => ({ ...session, modeId })),
    )

    const recordPartMetadata: Interface["recordPartMetadata"] = Effect.fn("ACP.Session.recordPartMetadata")((input) =>
      Ref.get(sessions).pipe(
        Effect.flatMap((state) => {
          const session = state.get(input.sessionId)
          if (!session) return new ACPError.SessionNotFoundError({ sessionId: input.sessionId })
          const metadata = {
            messageId: input.messageId,
            partId: input.partId,
            partType: input.partType,
            role: input.role,
            ignored: input.ignored,
            toolCallId: input.toolCallId,
            metadata: input.metadata,
          }
          session.knownParts.set(partMetadataKey(input), metadata)
          return Effect.succeed(metadata)
        }),
      ),
    )

    return Service.of({
      create: store,
      load: store,
      list: Effect.fn("ACP.Session.list")(function* (cwd?: string) {
        return [...(yield* Ref.get(sessions)).values()]
          .filter((session) => !cwd || session.cwd === cwd)
          .map(snapshot)
          .toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      }),
      get,
      tryGet,
      remove,
      setModel,
      getModel: Effect.fn("ACP.Session.getModel")(function* (sessionId) {
        const session = (yield* Ref.get(sessions)).get(sessionId)
        if (!session) return yield* new ACPError.SessionNotFoundError({ sessionId })
        return session.model
      }),
      setVariant,
      getVariant: Effect.fn("ACP.Session.getVariant")(function* (sessionId) {
        const session = (yield* Ref.get(sessions)).get(sessionId)
        if (!session) return yield* new ACPError.SessionNotFoundError({ sessionId })
        return session.variant
      }),
      setMode,
      getMode: Effect.fn("ACP.Session.getMode")(function* (sessionId) {
        const session = (yield* Ref.get(sessions)).get(sessionId)
        if (!session) return yield* new ACPError.SessionNotFoundError({ sessionId })
        return session.modeId
      }),
      recordPartMetadata,
      getPartMetadata: Effect.fn("ACP.Session.getPartMetadata")(function* (input) {
        const session = (yield* Ref.get(sessions)).get(input.sessionId)
        if (!session) return yield* new ACPError.SessionNotFoundError({ sessionId: input.sessionId })
        return session.knownParts.get(partMetadataKey(input))
      }),
      tryGetPartMetadata: Effect.fn("ACP.Session.tryGetPartMetadata")(function* (input) {
        return (yield* Ref.get(sessions)).get(input.sessionId)?.knownParts.get(partMetadataKey(input))
      }),
    })
  }),
)

export const defaultLayer = layer

function makeSession(input: StoreInput): StoredSession {
  return {
    id: input.id,
    cwd: input.cwd,
    mcpServers: [...(input.mcpServers ?? [])],
    createdAt: input.createdAt ? new Date(input.createdAt) : new Date(),
    model: input.model,
    variant: input.variant,
    modeId: input.modeId,
    knownParts: new Map(),
  }
}

function snapshot(session: StoredSession): Info {
  return {
    ...session,
    mcpServers: [...session.mcpServers],
    createdAt: new Date(session.createdAt),
  }
}

function partMetadataKey(input: { messageId: string; partId: string }) {
  return `${input.messageId}:${input.partId}`
}

export * as ACPSession from "./session"
