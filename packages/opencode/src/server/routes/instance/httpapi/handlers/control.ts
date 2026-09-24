import { Auth } from "@/auth"
import { UnknownError } from "../errors"

import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"
import { LogInput } from "../groups/control"
import { ProviderV2 } from "@opencode-ai/core/provider"

export const controlHandlers = HttpApiBuilder.group(RootHttpApi, "control", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* Auth.Service

    const authList = Effect.fn("ControlHttpApi.authList")(function* () {
      const saved = yield* auth.all().pipe(Effect.mapError(() => new UnknownError({ message: "Unable to load saved credentials." })))
      return Object.entries(saved).map(([providerID, info]) => ({
        providerID,
        type: info.type,
        removable: !process.env.DEVECO_AUTH_CONTENT,
        ...("isRealName" in info ? { isRealName: info.isRealName } : {}),
      }))
    })

    const authSet = Effect.fn("ControlHttpApi.authSet")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: Auth.Info
    }) {
      yield* auth.set(ctx.params.providerID, ctx.payload).pipe(Effect.orDie)
      return true
    })

    const authRemove = Effect.fn("ControlHttpApi.authRemove")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
    }) {
      yield* auth.remove(ctx.params.providerID).pipe(Effect.orDie)
      return true
    })

    const log = Effect.fn("ControlHttpApi.log")(function* (ctx: { payload: typeof LogInput.Type }) {
      const write =
        ctx.payload.level === "debug"
          ? Effect.logDebug
          : ctx.payload.level === "info"
            ? Effect.logInfo
            : ctx.payload.level === "warn"
              ? Effect.logWarning
              : Effect.logError
      yield* write(ctx.payload.message).pipe(Effect.annotateLogs(ctx.payload.extra ?? {}))
      return true
    })

    return handlers.handle("authList", authList).handle("authSet", authSet).handle("authRemove", authRemove).handle("log", log)
  }),
)
