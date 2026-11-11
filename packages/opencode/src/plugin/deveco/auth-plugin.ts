import crypto from "crypto"
import { URL } from "url"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { OAUTH_DUMMY_KEY } from "@/auth"
import { Global } from "@opencode-ai/core/global"
import { GlobalBus } from "@/bus/global"
import { logError, logWarn } from "./log"
import { TOOL_IMPROVEMENT_HEADER } from "@/cli/deveco-privacy-settings"
import { isImprovementConsentGranted } from "./improvement-consent"
import HuaweiEndpoints from "../../../huawei-endpoints.json"

import { devecoAuth } from "./auth"
import { sessionChatIdMap } from "./session"
import { ensureValidToken } from "./token-refresh"
import { ACCESS_TOKEN_EXPIRES_MS, PROVIDER_ID } from "./types"
import { MAINLAND_CHINA_ONLY_MESSAGE, regionPolicy } from "./region-policy"
import { requireDevEcoAccess } from "./access"
import type { AgreementConfig } from "@/cli/deveco-legal"

export { TOOL_IMPROVEMENT_HEADER }

// Once per process: the config hook may run again on reload, and one log line is enough.
let reservedProviderWarned = false

/**
 * The deveco provider is reserved for the built-in model catalog, so a user supplied
 * `provider.deveco` entry is ignored by the provider layer. The user-facing notice is rendered by
 * the TUI home screen (it reads the synced config); a toast from here would fire before the TUI
 * subscribes to events and never reach the user, and it could not follow the TUI locale.
 */
function logReservedProviderConfig() {
  if (reservedProviderWarned) return
  reservedProviderWarned = true
  logWarn("ignored user provider.deveco config: providerId deveco is reserved", { service: "deveco" })
}

export function isHuaweiInferenceRequest(input: RequestInfo | URL) {
  const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url)
  return (
    url.origin === HuaweiEndpoints.devecoStudio &&
    url.pathname.startsWith("/sse/codeGenie/maas/v2/") &&
    url.pathname.endsWith("/chat/completions")
  )
}

export async function DevEcoAuthPlugin(input: PluginInput): Promise<Hooks> {
  let agreement: AgreementConfig | undefined
  return {
    async config(config) {
      agreement = (config as { agreement?: AgreementConfig }).agreement
      // Every config source is filtered, including managed/console config: the filter is
      // "the id deveco is reserved", not "this particular file type is disallowed".
      if (config.provider?.deveco !== undefined) logReservedProviderConfig()
      // Best effort and fire-and-forget: a missing country/region file must never delay or
      // fail startup, and the promise never rejects.
      void devecoAuth.syncCountryRegion()
    },
    auth: {
      provider: PROVIDER_ID,
      async loader(getAuth, _provider) {
        const info = await getAuth()
        if (!info) return {}

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            if (isHuaweiInferenceRequest(requestInput)) {
              const region = await regionPolicy.checkAccess()
              if (!region.allowed) {
                return new Response(JSON.stringify({ error: MAINLAND_CHINA_ONLY_MESSAGE }), {
                  status: 451,
                  statusText: "Unavailable For Legal Reasons",
                  headers: { "Content-Type": "application/json" },
                })
              }
              try {
                await requireDevEcoAccess(agreement)
              } catch (error) {
                return Response.json({ error: error instanceof Error ? error.message : "HUAWEI authentication required" }, { status: 403 })
              }
            }

            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.delete("authorization")
                init.headers.delete("Authorization")
              } else if (Array.isArray(init.headers)) {
                init.headers = init.headers.filter(([key]) => key.toLowerCase() !== "authorization")
              } else {
                delete init.headers["authorization"]
                delete init.headers["Authorization"]
              }
            }

            const currentAuth = await getAuth()
            if (isHuaweiInferenceRequest(requestInput) && currentAuth?.type !== "oauth") {
              return Response.json({ error: "Sign in with HUAWEI ID to use built-in models." }, { status: 401 })
            }
            if (currentAuth?.type === "oauth") {
              if (!currentAuth.access || currentAuth.expires < Date.now()) {
                const newToken = await ensureValidToken()
                if (newToken) {
                  currentAuth.access = newToken
                } else {
                  logError("DevEco Code token refresh failed, user needs to re-login", { service: "deveco" })
                  GlobalBus.emit("event", {
                    directory: "global",
                    payload: {
                      type: "auth.token_refresh_failed",
                      properties: {
                        providerID: "deveco",
                        message: "Token refresh failed. Please re-login to DevEco Code.",
                      },
                    },
                  })
                  // 返回 401 错误响应，阻止使用过期 token 发送请求
                  return new Response(
                    JSON.stringify({ error: "Token refresh failed. Please re-login to DevEco Code." }),
                    {
                      status: 401,
                      statusText: "Unauthorized",
                      headers: { "Content-Type": "application/json" },
                    },
                  )
                }
              }
            }

            const headers = new Headers()
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.forEach((value, key) => headers.set(key, value))
              } else if (Array.isArray(init.headers)) {
                for (const [key, value] of init.headers) {
                  if (value !== undefined) headers.set(key, String(value))
                }
              } else {
                for (const [key, value] of Object.entries(init.headers)) {
                  if (value !== undefined) headers.set(key, String(value))
                }
              }
            }

            if (currentAuth?.type === "oauth" && currentAuth.access) {
              headers.set("authorization", `Bearer ${currentAuth.access}`)
            }

            headers.set("lang", "en")

            const sessionId = headers.get("x-deveco-session") || headers.get("x-session-affinity")
            const chatId = (sessionId && sessionChatIdMap.get(sessionId)) || crypto.randomUUID().replace(/-/g, "")
            headers.set("Chat-Id", chatId)
            if (sessionId) {
              headers.set("Session-Id", sessionId)
            }

            // DevEco Code API requires /no-stream in URL path for non-streaming requests
            // e.g. /v2/chat/completions → /v2/no-stream/chat/completions
            let finalInput: RequestInfo | URL = requestInput
            if (typeof init?.body === "string") {
              try {
                const body = JSON.parse(init.body)
                if (body?.stream !== true) {
                  const url =
                    requestInput instanceof URL
                      ? new URL(requestInput.toString())
                      : new URL(typeof requestInput === "string" ? requestInput : requestInput.url)
                  url.pathname = url.pathname
                    .replace(/\/$/, "")
                    .replace(/\/chat\/completions$/, "/no-stream/chat/completions")
                  finalInput = url
                }
              } catch {
                logError("Failed to rewrite URL for non-streaming request", {
                  service: "deveco",
                  requestInput: String(requestInput),
                })
              }
            }

            if (currentAuth?.type === "oauth" && isHuaweiInferenceRequest(finalInput)) {
              // T2.3 / FR-6: the header reflects the *current account's*
              // improvement consent (granted → "true"; declined/undecided/
              // signed out → "false").
              headers.set(TOOL_IMPROVEMENT_HEADER, String(await isImprovementConsentGranted()))
            } else {
              headers.delete(TOOL_IMPROVEMENT_HEADER)
            }

            return fetch(finalInput, {
              ...init,
              headers,
            })
          },
        }
      },
      methods: [
        {
          type: "oauth",
          label: "Sign in with HUAWEI ID",
          async authorize() {
            return {
              url: "",
              instructions: "Opening browser for login...",
              method: "auto" as const,
              cancel: () => devecoAuth.cancel(),
              async callback() {
                const result = await devecoAuth.login()

                if (!result.success) {
                  if (result.unsupportedRegion) {
                    return {
                      type: "failed" as const,
                      error: result.error ?? "DevEco Code currently only supports China-region accounts.",
                    }
                  }
                  return { type: "failed" as const }
                }

                const access = result.userInfo?.accessToken || ""
                const refresh = result.userInfo?.refreshToken || ""

                if (!access) {
                  return { type: "failed" as const, error: "Login succeeded but no access token received" }
                }

                return {
                  type: "success" as const,
                  provider: PROVIDER_ID,
                  access,
                  refresh,
                  expires: Date.now() + ACCESS_TOKEN_EXPIRES_MS,
                  isRealName: result.userInfo?.isRealName ?? false,
                }
              },
            }
          },
        },
      ],
    },
  }
}
