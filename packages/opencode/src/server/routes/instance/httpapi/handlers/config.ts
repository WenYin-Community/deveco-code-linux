import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { getTaskDefaultModelMap } from "@/plugin/deveco-models"
import * as InstanceState from "@/effect/instance-state"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { markInstanceForDisposal } from "../lifecycle"

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const providerSvc = yield* Provider.Service
    const configSvc = yield* Config.Service

    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      const config = yield* configSvc.get()
      const provider = config.provider?.deveco
      if (provider?.options?.task_default_model_map !== undefined) return config
      const defaults = getTaskDefaultModelMap()
      if (!defaults || Object.keys(defaults).length === 0) return config
      // Export runtime defaults without initializing providers or mutating configuration.
      return {
        ...config,
        provider: {
          ...config.provider,
          deveco: {
            ...provider,
            options: { ...provider?.options, task_default_model_map: { ...defaults } },
          },
        },
      }
    })

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      yield* configSvc.update(ctx.payload)
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return ctx.payload
    })

    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      const providers = yield* providerSvc.list()
      return {
        providers: Object.values(providers).map(Provider.toPublicInfo),
        default: Provider.defaultModelIDs(providers),
      }
    })

    return handlers.handle("get", get).handle("update", update).handle("providers", providers)
  }),
)
