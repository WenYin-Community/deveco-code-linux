export * as Credential from "./credential"

import { asc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "./database/database"
import { IntegrationSchema } from "./integration/schema"
import { NonNegativeInt, withStatics } from "./schema"
import { Identifier } from "./util/identifier"
import { CredentialTable } from "./credential/sql"
import { isSealed, open, seal } from "./credential/crypto"
import { loadKey } from "./credential/keychain"

export const ID = Schema.String.pipe(
  Schema.brand("Credential.ID"),
  withStatics((schema) => ({ create: () => schema.make("cred_" + Identifier.ascending()) })),
)
export type ID = typeof ID.Type

export class OAuth extends Schema.Class<OAuth>("Credential.OAuth")({
  type: Schema.Literal("oauth"),
  methodID: IntegrationSchema.MethodID,
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class Key extends Schema.Class<Key>("Credential.Key")({
  type: Schema.Literal("key"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export const Info = Schema.Union([OAuth, Key])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Credential.Info" })
export type Info = Schema.Schema.Type<typeof Info>

export class Stored extends Schema.Class<Stored>("Credential.Stored")({
  id: ID,
  integrationID: IntegrationSchema.ID,
  label: Schema.String,
  value: Info,
}) {}

export interface Interface {
  /** Returns every stored credential. */
  readonly all: () => Effect.Effect<Stored[]>
  /** Returns stored credentials belonging to one integration. */
  readonly list: (integrationID: IntegrationSchema.ID) => Effect.Effect<Stored[]>
  /** Returns one stored credential by ID. */
  readonly get: (id: ID) => Effect.Effect<Stored | undefined>
  /** Replaces any credential for an integration and returns the new record. */
  readonly create: (input: {
    readonly integrationID: IntegrationSchema.ID
    readonly value: Info
    readonly label?: string
  }) => Effect.Effect<Stored>
  /** Updates the label or secret value of a stored credential. */
  readonly update: (id: ID, updates: Partial<Pick<Stored, "label" | "value">>) => Effect.Effect<void>
  /** Removes a stored credential. */
  readonly remove: (id: ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Credential") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db, filename } = yield* Database.Service
    // Defer key loading until the first credential read/write so the .key
    // file is not created when the credential table stays empty.
    const getKey = yield* Effect.cached(loadKey(filename))
    const encode = Schema.encodeSync(Info)
    const decode = Schema.decodeUnknownSync(Info)
    // Bind each ciphertext to its row so values cannot be swapped between rows.
    const aad = (id: ID) => `credential:${id}:value`
    const stored = (key: Uint8Array, row: typeof CredentialTable.$inferSelect) => {
      if (!row.integration_id) return
      return new Stored({
        id: row.id,
        integrationID: row.integration_id,
        label: row.label,
        // Rows written before encryption was introduced stay readable as
        // plaintext JSON and are sealed on their next write (lazy migration).
        value: decode(JSON.parse(isSealed(row.value) ? open(key, aad(row.id), row.value) : row.value)),
      })
    }

    return Service.of({
      all: Effect.fn("Credential.all")(function* () {
        const rows = yield* db
          .select()
          .from(CredentialTable)
          .orderBy(asc(CredentialTable.time_created))
          .all()
          .pipe(Effect.orDie)
        if (rows.length === 0) return []
        const key = yield* getKey
        return rows.flatMap((row) => {
          const credential = stored(key, row)
          return credential ? [credential] : []
        })
      }),
      list: Effect.fn("Credential.list")(function* (integrationID) {
        const rows = yield* db
          .select()
          .from(CredentialTable)
          .where(eq(CredentialTable.integration_id, integrationID))
          .orderBy(asc(CredentialTable.time_created))
          .all()
          .pipe(Effect.orDie)
        if (rows.length === 0) return []
        const key = yield* getKey
        return rows.flatMap((row) => {
          const credential = stored(key, row)
          return credential ? [credential] : []
        })
      }),
      get: Effect.fn("Credential.get")(function* (id) {
        const row = yield* db.select().from(CredentialTable).where(eq(CredentialTable.id, id)).get().pipe(Effect.orDie)
        if (!row) return undefined
        const key = yield* getKey
        return stored(key, row)
      }),
      create: Effect.fn("Credential.create")(function* (input) {
        const key = yield* getKey
        const credential = new Stored({
          id: ID.create(),
          integrationID: input.integrationID,
          label: input.label ?? "default",
          value: input.value,
        })
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .delete(CredentialTable)
                .where(eq(CredentialTable.integration_id, credential.integrationID))
                .run()
              yield* tx
                .insert(CredentialTable)
                .values({
                  id: credential.id,
                  integration_id: credential.integrationID,
                  label: credential.label,
                  value: seal(key, aad(credential.id), JSON.stringify(encode(credential.value))),
                })
                .run()
            }),
          )
          .pipe(Effect.orDie)
        return credential
      }),
      update: Effect.fn("Credential.update")(function* (id, updates) {
        if (!updates.label && !updates.value) return
        const key = yield* getKey
        yield* db
          .update(CredentialTable)
          .set({
            label: updates.label,
            value: updates.value ? seal(key, aad(id), JSON.stringify(encode(updates.value))) : undefined,
          })
          .where(eq(CredentialTable.id, id))
          .run()
          .pipe(Effect.orDie)
      }),
      remove: Effect.fn("Credential.remove")(function* (id) {
        yield* db.delete(CredentialTable).where(eq(CredentialTable.id, id)).run().pipe(Effect.orDie)
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
