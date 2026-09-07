import { Npm } from "@opencode-ai/core/npm"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import type { Draft } from "immer"
import { Catalog } from "@opencode-ai/core/catalog"
import { Integration } from "@opencode-ai/core/integration"
import { Credential } from "@opencode-ai/core/credential"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

function applyKey(provider: Draft<ProviderV2.Info>, value: Credential.Key) {
  const blocked = new Set(["apikey", "baseurl", "url"])
  for (const [key, val] of Object.entries(value.metadata ?? {})) {
    if (!blocked.has(key.toLowerCase())) provider.request.body[key] = val
  }
  provider.request.body.apiKey = value.key
}

function applyCredential(provider: Draft<ProviderV2.Info>, value: Credential.Info) {
  if (value.type === "key") {
    applyKey(provider, value)
    return
  }
  if (value.type === "oauth") provider.request.body.apiKey = value.access
}

export function accountMergePlugin(credentials: Credential.Interface) {
  return PluginV2.define({
    id: PluginV2.ID.make("test-account-merge"),
    effect: Effect.succeed({
      "catalog.transform": Effect.fn(function* (evt) {
        const stored = yield* credentials.all()
        for (const cred of stored) {
          evt.provider.list()
            .filter((item) => String(item.provider.id) === String(cred.integrationID))
            .forEach((item) => evt.provider.update(item.provider.id, (provider) => applyCredential(provider, cred.value)))
        }
      }),
    }),
  })
}

export const fixtureProvider = new URL("./fixtures/provider-factory.ts", import.meta.url).href
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("test") })),
)

export const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: () => Effect.succeed({ directory: "", entrypoint: Option.none<string>() }),
    install: () => Effect.void,
    which: () => Effect.succeed(Option.none<string>()),
  }),
)

export const catalogLayer = Layer.succeed(
  Catalog.Service,
  Catalog.Service.of({
    transform: () => Effect.die("unexpected catalog.transform"),
    provider: {
      get: () => Effect.die("unexpected provider.get"),
      all: () => Effect.succeed([]),
      available: () => Effect.succeed([]),
    },
    model: {
      get: () => Effect.die("unexpected model.get"),
      all: () => Effect.succeed([]),
      available: () => Effect.succeed([]),
      default: () => Effect.succeed(Option.none<ModelV2.Info>()),
      small: () => Effect.succeed(Option.none<ModelV2.Info>()),
    },
  }),
)

const integrations = Integration.locationLayer.pipe(
  Layer.provide(EventV2.defaultLayer),
  Layer.provide(
    Layer.mock(Credential.Service)({
      create: () => Effect.die("unexpected credential creation"),
      all: () => Effect.succeed([]),
      list: () => Effect.succeed([]),
    }),
  ),
)

export const it = testEffect(
  Catalog.locationLayer.pipe(
    Layer.provideMerge(integrations),
    Layer.provideMerge(
      Layer.mock(Credential.Service)({
        all: () => Effect.succeed([]),
      }),
    ),
    Layer.provideMerge(EventV2.defaultLayer),
    Layer.provideMerge(locationLayer),
    Layer.provideMerge(npmLayer),
  ),
)

type ProviderInput = Partial<Omit<ProviderV2.Info, "api" | "request">> & {
  api?: ProviderV2.Api
  request?: ProviderV2.Request
}

type ModelInput = Partial<Omit<ModelV2.Info, "api" | "request">> & {
  api?: (ProviderV2.Api & { id?: ModelV2.ID }) | { id: ModelV2.ID }
  request?: ModelV2.Info["request"]
}

export function provider(providerID: string, options?: ProviderInput) {
  return new ProviderV2.Info({
    ...ProviderV2.Info.empty(ProviderV2.ID.make(providerID)),
    api: options?.api ?? {
      type: "aisdk",
      package: "test-provider",
    },
    ...options,
    request: {
      headers: {},
      body: {},
      ...options?.request,
    },
  })
}

export function model(providerID: string, modelID: string, options?: ModelInput) {
  return new ModelV2.Info({
    ...ModelV2.Info.empty(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID)),
    ...options,
    api:
      options?.api && "type" in options.api
        ? { id: ModelV2.ID.make(modelID), ...options.api }
        : {
            id: ModelV2.ID.make(modelID),
            ...options?.api,
            type: "aisdk",
            package: "test-provider",
          },
    request: {
      headers: {},
      body: {},
      ...options?.request,
    },
  })
}

export function withEnv<A, E, R>(vars: Record<string, string | undefined>, fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
      for (const [key, value] of Object.entries(vars)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      return previous
    }),
    () => fx(),
    (previous) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }),
  )
}

export function fakeSelectorSdk(calls: string[]) {
  const make = (method: string) => (id: string) => {
    calls.push(`${method}:${id}`)
    return { modelId: id, provider: method, specificationVersion: "v3" } as unknown as LanguageModelV3
  }
  return {
    responses: make("responses"),
    messages: make("messages"),
    chat: make("chat"),
    languageModel: make("languageModel"),
  }
}

export function expectPluginRegistered(ids: string[], id: string) {
  expect(ids).toContain(PluginV2.ID.make(id))
}
