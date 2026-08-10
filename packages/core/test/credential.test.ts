import path from "path"
import { readFileSync, writeFileSync } from "fs"
import { randomBytes } from "crypto"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Credential } from "@opencode-ai/core/credential"
import { CredentialTable } from "@opencode-ai/core/credential/sql"
import { Database } from "@opencode-ai/core/database/database"
import { Integration } from "@opencode-ai/core/integration"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

function layer(directory: string) {
  return Credential.layer.pipe(
    Layer.provide(Database.layerFromPath(path.join(directory, "credential.db")).pipe(Layer.fresh)),
  )
}

// Shares one Database layer between Credential and the test effect so raw rows
// can be inspected below the service boundary.
function environment(directory: string) {
  const database = Database.layerFromPath(path.join(directory, "credential.db"))
  return Layer.mergeAll(database, Credential.layer.pipe(Layer.provide(database)))
}

describe("Credential", () => {
  it.live("stores, updates, lists, and removes credentials", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const integrationID = Integration.ID.make("openai")
          const created = yield* credentials.create({
            integrationID,
            label: "Work",
            value: new Credential.Key({ type: "key", key: "secret" }),
          })

          expect(yield* credentials.list(integrationID)).toEqual([created])
          yield* credentials.update(created.id, { label: "Personal" })
          expect((yield* credentials.list(integrationID))[0]?.label).toBe("Personal")

          const replacement = yield* credentials.create({
            integrationID,
            label: "Replacement",
            value: new Credential.Key({ type: "key", key: "replacement" }),
          })
          expect(yield* credentials.list(integrationID)).toEqual([replacement])

          yield* credentials.remove(replacement.id)
          expect(yield* credentials.list(integrationID)).toEqual([])
        }).pipe(Effect.provide(layer(tmp.path))),
      ),
    ),
  )

  it.live("seals values at rest and reads them back", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const { db } = yield* Database.Service
          const integrationID = Integration.ID.make("openai")
          const created = yield* credentials.create({
            integrationID,
            value: new Credential.OAuth({
              type: "oauth",
              methodID: Integration.MethodID.make("default"),
              access: "access",
              refresh: "refresh",
              expires: 1,
            }),
          })

          const rows = yield* db.select().from(CredentialTable).all().pipe(Effect.orDie)
          expect(rows).toHaveLength(1)
          expect(rows[0]!.value.startsWith("v1.")).toBe(true)
          expect(rows[0]!.value).not.toContain("access")
          expect(rows[0]!.value).not.toContain("refresh")
          // Windows guards the key file content with DPAPI; macOS/Linux keep
          // the key in the OS keychain so no key file exists there.
          if (process.platform === "win32") {
            // A DPAPI blob is longer than the 44 base64 chars of a raw key.
            expect(readFileSync(path.join(tmp.path, "credential.db.key"), "utf8").length).toBeGreaterThan(44)
          }

          expect(yield* credentials.get(created.id)).toEqual(created)

          yield* credentials.update(created.id, {
            value: new Credential.Key({ type: "key", key: "rotated" }),
          })
          expect((yield* credentials.get(created.id))?.value).toEqual(
            new Credential.Key({ type: "key", key: "rotated" }),
          )
        }).pipe(Effect.provide(environment(tmp.path))),
      ),
    ),
  )

  it.live("reads legacy plaintext rows (lazy migration)", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const { db } = yield* Database.Service
          const integrationID = Integration.ID.make("openai")
          const id = Credential.ID.create()
          yield* db
            .insert(CredentialTable)
            .values({
              id,
              integration_id: integrationID,
              label: "Legacy",
              value: JSON.stringify({ type: "key", key: "legacy-secret" }),
            })
            .run()
            .pipe(Effect.orDie)

          expect((yield* credentials.get(id))?.value).toEqual(
            new Credential.Key({ type: "key", key: "legacy-secret" }),
          )
        }).pipe(Effect.provide(environment(tmp.path))),
      ),
    ),
  )

  if (process.platform === "win32") {
    it.live("migrates a legacy plaintext key file under DPAPI protection", () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((tmp) => {
          // Written before the layer builds: Credential.layer loads the key
          // once at construction time.
          const file = path.join(tmp.path, "credential.db.key")
          writeFileSync(file, randomBytes(32).toString("base64"))
          return Effect.gen(function* () {
            const credentials = yield* Credential.Service
            const integrationID = Integration.ID.make("openai")
            const created = yield* credentials.create({
              integrationID,
              value: new Credential.Key({ type: "key", key: "dpapi-migrated" }),
            })

            // The raw 32-byte key is 44 base64 chars; a DPAPI blob is longer.
            expect(readFileSync(file, "utf8").length).toBeGreaterThan(44)
            expect(yield* credentials.get(created.id)).toEqual(created)
          }).pipe(Effect.provide(environment(tmp.path)))
        }),
      ),
    )
  }
})
