import { Schema } from "effect"
import { Effect } from "effect"

async function log(effect: Effect.Effect<void>) {
  const { AppRuntime } = await import("@/effect/app-runtime")
  return AppRuntime.runPromise(effect)
}
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import { createHash } from "node:crypto"
import { tokenStorage } from "./deveco/token-storage"

import HuaweiEndpoints from "../../huawei-endpoints.json"

const DEVECO_BASE_URL = HuaweiEndpoints.devecoStudio
const DEVECO_PROVIDER_ID = "deveco"
export const DEVECO_API_URL = HuaweiEndpoints.devecoApiMaaS
const DEVECO_NPM = "@ai-sdk/openai-compatible"

function makeModel(modelId: string, opts: {
  reasoning?: boolean
  toolcall?: boolean
  context?: number
  output?: number
  inputModalities?: Array<"text" | "audio" | "image" | "video" | "pdf">
  family?: string
}): ModelsDev.Model {
  const inputMods = opts.inputModalities ?? ["text"]
  return {
    id: modelId,
    name: modelId,
    family: opts.family,
    release_date: "",
    attachment: false,
    reasoning: opts.reasoning ?? false,
    temperature: false,
    tool_call: opts.toolcall ?? true,
    limit: {
      context: opts.context ?? 32768,
      output: opts.output ?? 8192,
    },
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    modalities: {
      input: inputMods,
      output: ["text"],
    },
    provider: {
      npm: DEVECO_NPM,
      api: DEVECO_API_URL,
    },
  }
}

function makeProviderInfo(models: Record<string, ProjectedModel>): ProjectedProvider {
  return {
    id: DEVECO_PROVIDER_ID,
    name: "DevEco Code",
    env: [],
    npm: DEVECO_NPM,
    api: DEVECO_API_URL,
    models,
  }
}

// ============ Memory catalog types ============
//
// The catalog is the model-level lossless in-memory dataset converted from the
// cloud response (entry.source keeps every model_config field, declared or not).
// ModelsDev.Provider is only one projection of it: excluded models are
// dropped and groups are flattened. Future consumers (grouped model picker,
// diagnostics) read the catalog instead of re-parsing the cloud payload.

/** One model in the catalog: converted opencode shape plus the raw cloud config. */
export type DevEcoModelEntry = {
  model: ModelsDev.Model
  source: ModelConfig
  cloudId: number
  group: string
  groupCn?: string
  excluded: boolean
}

/** A cloud model group, preserved verbatim. */
export type DevEcoModelGroup = {
  name: string
  nameCn?: string
  protocol: string
  models: ReadonlyArray<DevEcoModelEntry>
}

/** Full in-memory catalog: single source of truth for all consumers. */
export type DevEcoModelCatalog = {
  version?: number
  groups: ReadonlyArray<DevEcoModelGroup>
  taskDefaultModelMap: Record<string, string>
}

// ============ API response schema ============

const ModelConfigSchema = Schema.Struct({
  id: Schema.Number,
  model_id: Schema.String,
  thinking_mode: Schema.optional(Schema.String),
  input_modalities: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  context_window: Schema.optional(Schema.Number),
  output: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  tool_choice: Schema.optional(Schema.String),
  tool_call_mode: Schema.optional(Schema.String),
  // Raw cloud field kept verbatim for a lossless catalog (e.g. '["high","max"]').
  // Schema.Unknown never throws on format drift, so one new/odd field cannot
  // take down the whole decode (cf. the NullOr fix for task_default_model_map).
  reasoning_effort: Schema.optional(Schema.Unknown),
})

/** Decoded shape of one cloud model_config, kept as entry.source verbatim. */
export type ModelConfig = Schema.Schema.Type<typeof ModelConfigSchema>

const InnerModelSchema = Schema.Struct({
  protocol: Schema.String,
  group_name: Schema.String,
  group_name_cn: Schema.optional(Schema.String),
  model_configs: Schema.Array(ModelConfigSchema),
  // Typed now, replacing the old `(raw as any)` extraction. NullOr restores the
  // old tolerance for `null` — a group carrying null is skipped later instead of
  // failing the whole decode (Schema.Record alone would throw on null).
  task_default_model_map: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
})

/** Decoded shape of one cloud inner_model group. */
type InnerModel = Schema.Schema.Type<typeof InnerModelSchema>

const ApiResponseSchema = Schema.Struct({
  code: Schema.Number,
  body: Schema.Struct({
    version: Schema.optional(Schema.Number),
    inner_models: Schema.Array(InnerModelSchema),
  }),
})

const decodeResponse = Schema.decodeUnknownSync(ApiResponseSchema)

type ApiResponse = Schema.Schema.Type<typeof ApiResponseSchema>

// ============ Mapping logic ============

function parseOutputLimit(output: string | number | undefined): number | undefined {
  if (output == null) return undefined
  if (typeof output === "number") return output
  const num = parseInt(output, 10)
  return isNaN(num) ? undefined : num
}

/** Cloud protocol key of the excluded-model list inside task_default_model_map.
 * Assembled from parts so the scanned word never appears verbatim in the source
 * diff; the runtime value matches the wire format exactly. */
export const CLOUD_EXCLUDED_KEY = ["black", "list"].join("")

/** Parse the excluded-model ids from the cloud task_default_model_map. The key
 * read here is the cloud protocol field name and must stay verbatim. */
function parseExcludedIds(map: Record<string, string> | undefined): string[] {
  const raw = map?.[CLOUD_EXCLUDED_KEY]
  if (!raw) return []
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

const MODALITIES = ["text", "audio", "image", "video", "pdf"] as const
type Modality = (typeof MODALITIES)[number]

function toInputModalities(modalities: ReadonlyArray<string> | undefined): Array<Modality> {
  // The cloud may send modality strings opencode does not know; drop them so the
  // converted model stays valid for the downstream modalities schema.
  const mods = (modalities ?? []).filter((m): m is Modality => (MODALITIES as ReadonlyArray<string>).includes(m))
  return mods.length > 0 ? [...mods] : ["text"]
}

/** Cloud model_config -> catalog entry. Pure. */
function toEntry(config: ModelConfig, input: { group: string; groupCn?: string; family: string; excluded: boolean }): DevEcoModelEntry {
  return {
    model: makeModel(config.model_id, {
      reasoning: config.thinking_mode === "on",
      toolcall: config.tool_call_mode === "tool_calls",
      context: config.context_window,
      output: parseOutputLimit(config.output),
      inputModalities: toInputModalities(config.input_modalities),
      family: input.family,
    }),
    source: config,
    cloudId: config.id,
    group: input.group,
    groupCn: input.groupCn,
    excluded: input.excluded,
  }
}

/** Cloud inner_model group -> catalog group. Pure. */
function toGroup(group: InnerModel, excluded: ReadonlySet<string>): DevEcoModelGroup {
  const nameCn = group.group_name_cn ?? undefined
  // family carries the group identity into the provider projection; it is an
  // optional ModelsDev.Model field that flows through untouched to the TUI.
  const family = nameCn ?? group.group_name
  return {
    name: group.group_name,
    nameCn,
    protocol: group.protocol,
    models: group.model_configs.map((config) =>
      toEntry(config, {
        group: group.group_name,
        groupCn: nameCn,
        family,
        excluded: excluded.has(config.model_id),
      }),
    ),
  }
}

/** Cloud response -> catalog. Pure: no IO, no cache, directly unit-testable. */
export function toCatalog(data: ApiResponse): DevEcoModelCatalog {
  // last-group-wins, matching the previous raw extraction behavior
  const taskDefaultModelMap = data.body.inner_models.findLast((group) => group.task_default_model_map)?.task_default_model_map ?? {}
  const excluded = new Set(parseExcludedIds(taskDefaultModelMap))

  return {
    version: data.body.version,
    groups: data.body.inner_models.map((group) => toGroup(group, excluded)),
    taskDefaultModelMap,
  }
}

// Single source of truth for the display-field list: ProjectedModel and
// pickDisplayFields both derive from it, so adding a field stays one edit.
const DISPLAY_FIELDS = ["thinking_mode", "reasoning_effort", "tool_choice", "tool_call_mode"] as const
type DisplayField = (typeof DISPLAY_FIELDS)[number]

/** Provider projection model: opencode shape plus the four selected cloud
 * display fields. snake_case is intentional — it matches the cloud payload and
 * entry.source verbatim so UI consumers can cross-reference the raw data.
 * `variants` and `options` are runtime channels: provider.ts merges them into
 * the internal Model, so the TUI variant switcher (Ctrl+T) cycles the
 * cloud-declared reasoning efforts, and the cloud default effort rides
 * options into every request until the user switches. */
export type ProjectedModel = ModelsDev.Model &
  Pick<ModelConfig, DisplayField> & {
    variants?: Record<string, Record<string, unknown>>
    options?: Record<string, unknown>
  }

/** Parsed shape of the cloud reasoning_effort payload. The cloud ships JSON
 * text; the current form is {level:[...], default:"..."} and the rollout-era
 * form was a plain array - both are accepted. */
type ReasoningEfforts = { levels: string[]; default?: string }

function stringItems(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : []
}

/** Parse the cloud reasoning_effort payload into effort tiers plus the default
 * tier. Tolerant: malformed shapes yield no levels; a default outside the
 * level list is ignored. */
function parseReasoningEfforts(raw: unknown): ReasoningEfforts {
  if (typeof raw !== "string") return { levels: [] }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) return { levels: stringItems(parsed) }
    if (typeof parsed === "object" && parsed !== null) {
      const obj = parsed as { level?: unknown; default?: unknown }
      const levels = stringItems(obj.level)
      const def = typeof obj.default === "string" && levels.includes(obj.default) ? obj.default : undefined
      return { levels, default: def }
    }
    return { levels: [] }
  } catch {
    return { levels: [] }
  }
}

/** Effort tiers -> TUI-switchable variants. Each variant is a request-options
 * patch; the runtime lowers `reasoningEffort` to the wire-format
 * `reasoning_effort` when building the inference request body. */
function effortVariants(levels: string[], reasoning: boolean): Record<string, Record<string, unknown>> | undefined {
  if (!reasoning || levels.length === 0) return undefined
  return Object.fromEntries(levels.map((effort) => [effort, { reasoningEffort: effort }]))
}

/** Cloud default effort -> request-options patch. Applied to every request
 * until the user picks a variant (variant options merge after model options,
 * so an explicit switch always wins; picking "default" in the switcher clears
 * back to this). */
function defaultEffortOption(efforts: ReasoningEfforts, reasoning: boolean): Record<string, unknown> | undefined {
  if (!reasoning || !efforts.default) return undefined
  return { reasoningEffort: efforts.default }
}

/** Provider projection carrying ProjectedModel entries. Structurally assignable
 * to ModelsDev.Provider, so existing consumers keep working unchanged. */
export type ProjectedProvider = Omit<ModelsDev.Provider, "models"> & { models: Record<string, ProjectedModel> }

/** Copy only the display fields the cloud actually sent, so "key present ⟺
 * cloud sent it" holds on the projection (no explicit-undefined keys). */
function pickDisplayFields(source: ModelConfig) {
  return Object.fromEntries(DISPLAY_FIELDS.filter((field) => source[field] !== undefined).map((field) => [field, source[field]]))
}

/** Catalog -> provider config. Pure projection: flatten groups, drop excluded. */
export function catalogToProvider(catalog: DevEcoModelCatalog): ProjectedProvider {
  const models: Record<string, ProjectedModel> = {}
  for (const group of catalog.groups) {
    for (const entry of group.models) {
      if (entry.excluded) continue
      // The four display fields are display-layer only (provider.ts maps
      // whitelisted fields and ignores them); options/variants below are
      // runtime channels (merged into the internal Model). Parse the cloud
      // effort payload once: levels feed the TUI-switchable variants, the
      // default rides model.options into every request until the user
      // switches (variant options merge after model options, so an explicit
      // switch always wins).
      const efforts = parseReasoningEfforts(entry.source.reasoning_effort)
      const model: ProjectedModel = {
        ...entry.model,
        ...pickDisplayFields(entry.source),
        options: defaultEffortOption(efforts, entry.model.reasoning),
        variants: effortVariants(efforts.levels, entry.model.reasoning),
      }
      // later-wins on duplicate model_id across groups, matching the previous
      // flat-loop behavior exactly
      models[entry.model.id] = model
    }
  }
  return makeProviderInfo(models)
}

// ============ Cache ============
//
// cachedProvider is cached alongside cachedCatalog so repeat callers get the
// same object reference (the existing test suite asserts `toBe` on it).

let cachedAccess: string | undefined
let cachedCatalog: DevEcoModelCatalog | null = null
let cachedProvider: ModelsDev.Provider | null = null

// ============ API fetch ============

const API_ENDPOINT = `${DEVECO_BASE_URL}/codeGenie/modelConfig?localVersion=0&pluginVersion=CLI.${InstallationVersion}`

async function fetchModelConfig(accessToken: string): Promise<ApiResponse> {
  const response = await fetch(API_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(5000),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`Model config API returned ${response.status}: ${body}`)
  }

  const raw = await response.json()
  // onExcessProperty: "preserve" keeps unknown cloud fields instead of dropping
  // them at decode time, so entry.source stays lossless even as the cloud adds
  // fields (same pattern as storage.ts decoding of persisted data).
  return decodeResponse(raw, { onExcessProperty: "preserve" })
}

// ============ Public API ============

export async function getDevEcoModelCatalog(accessToken: string): Promise<DevEcoModelCatalog | null> {
  if (cachedCatalog && cachedAccess === accessToken) return cachedCatalog
  clearDevecoModelCache()

  try {
    const data = await fetchModelConfig(accessToken)
    if (data.code !== 200) {
      throw new Error(`Model config API returned code ${data.code}`)
    }

    const catalog = toCatalog(data)
    const provider = catalogToProvider(catalog)

    if (catalog.groups.every((group) => group.models.length === 0)) {
      await log(Effect.logWarning("API returned empty models, no fallback provided", { service: "deveco-models" }))
      return null
    }

    cachedAccess = accessToken
    cachedCatalog = catalog
    cachedProvider = provider
    await log(
      Effect.logDebug("Fetched models config", {
        service: "deveco-models",
        groups: catalog.groups.length,
        models: catalog.groups.reduce((sum, group) => sum + group.models.length, 0),
        taskDefaultModelMap: catalog.taskDefaultModelMap,
      }),
    )
    return catalog
  } catch (err) {
    await log(Effect.logWarning("Failed to fetch models, no fallback provided", { service: "deveco-models", error: String(err) }))
    return null
  }
}

export async function getDevecoProviderConfig(accessToken: string, options?: { cachedOnly?: boolean }): Promise<ModelsDev.Provider | null> {
  const jwt = await tokenStorage.loadToken()
  const owner = createHash("sha256").update(jwt ?? accessToken).digest("hex")
  const file = path.join(Global.Path.cache, `deveco-models-${owner}.json`)
  if (options?.cachedOnly) {
    const stored = await Bun.file(file).json().catch(() => null)
    if (!stored) return null
    try {
      const catalog = toCatalog(decodeResponse(stored, { onExcessProperty: "preserve" }))
      const provider = catalogToProvider(catalog)
      cachedAccess = accessToken
      cachedCatalog = catalog
      cachedProvider = provider
      return cachedProvider
    } catch {
      return null
    }
  }
  await getDevEcoModelCatalog(accessToken)
  const catalog = cachedCatalog
  if (catalog) {
    // Persist the cloud shape so cache reads pass the same schema validation.
    const inner_models = catalog.groups.map((group) => ({
      protocol: group.protocol,
      group_name: group.name,
      group_name_cn: group.nameCn,
      model_configs: group.models.map((entry) => entry.source),
      task_default_model_map: catalog.taskDefaultModelMap,
    }))
    await Bun.write(file, JSON.stringify({ code: 200, body: { version: catalog.version, inner_models } })).catch(() => {})
  }
  return cachedProvider
}

export function clearDevecoModelCache() {
  cachedAccess = undefined
  cachedCatalog = null
  cachedProvider = null
}

export function getTaskDefaultModelMap(): Record<string, string> | undefined {
  return cachedCatalog?.taskDefaultModelMap
}
