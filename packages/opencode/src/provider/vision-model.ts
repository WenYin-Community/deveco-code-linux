import { DEVECO_API_URL, getTaskDefaultModelMap } from "@/plugin/deveco-models"
import { requireDevEcoAccess } from "@/plugin/deveco/access"

export type VisionModelParams = {
  baseURL: string | null
  apiKey: string | null
  modelName: string | null
}

// Keep the existing ui_verification configuration contract for both vision tools
// and UI verification while allowing their runtimes to be removed independently.
export async function resolveVisionModel(worktree: string): Promise<VisionModelParams> {
  try {
    const { Effect } = await import("effect")
    const { AppRuntime } = await import("@/effect/app-runtime")
    const { Config } = await import("@/config/config")
    const { Provider } = await import("@/provider/provider")
    const { InstanceStore } = await import("@/project/instance-store")
    const result = await AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: worktree },
          Effect.gen(function* () {
            const config = yield* Config.Service
            const cfg = yield* config.get()
            const modelStr = cfg.agent?.["ui_verification"]?.model
            if (!modelStr) return null
            const { providerID, modelID } = Provider.parseModel(modelStr)
            const svc = yield* Provider.Service
            const provider = yield* svc.getProvider(providerID).pipe(Effect.catch(() => Effect.succeed(null)))
            const model = yield* svc.getModel(providerID, modelID).pipe(Effect.catch(() => Effect.succeed(null)))
            if (!provider || !model) return null
            return {
              baseURL: (provider.options?.baseURL as string | undefined) ?? model.api.url ?? null,
              apiKey:
                providerID === "deveco"
                  ? yield* Effect.promise(() => requireDevEcoAccess(cfg.agreement))
                  : (provider.key ?? (provider.options?.apiKey as string | undefined) ?? null),
              modelName: model.api.id ?? null,
            }
          }),
        ),
      ),
    )
    if (result) return result
  } catch {}

  if (process.env.UI_VERIFY_BASE_URL && process.env.UI_VERIFY_API_KEY && process.env.UI_VERIFY_MODEL_NAME) {
    return {
      baseURL: process.env.UI_VERIFY_BASE_URL,
      apiKey: process.env.UI_VERIFY_API_KEY,
      modelName: process.env.UI_VERIFY_MODEL_NAME,
    }
  }

  try {
    const access = await requireDevEcoAccess()
    return {
      baseURL: DEVECO_API_URL + "/no-stream",
      apiKey: access,
      modelName: getTaskDefaultModelMap()?.["ui_verification"] ?? "Qwen3_5_397B_A17B_w8a8_single",
    }
  } catch {}

  return { baseURL: null, apiKey: null, modelName: null }
}
