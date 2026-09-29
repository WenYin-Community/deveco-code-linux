import { describe, expect, test } from "bun:test"
import {
  CodexAuthPlugin,
  parseJwtClaims,
  extractAccountIdFromClaims,
  extractAccountId,
  renderOAuthError,
  type IdTokenClaims,
} from "../../src/plugin/openai/codex"

function createTestJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.sig`
}

describe("plugin.codex", () => {
  test("escapes provider errors in callback HTML", () => {
    const error = `</div><script>alert("xss" & 'more')</script>`
    const html = renderOAuthError(error)

    expect(html).toContain("&lt;/div&gt;&lt;script&gt;alert(&quot;xss&quot; &amp; &#39;more&#39;)&lt;/script&gt;")
    expect(html).not.toContain(error)
  })

  describe("parseJwtClaims", () => {
    test("parses valid JWT with claims", () => {
      const payload = { email: "test@example.com", chatgpt_account_id: "acc-123" }
      const jwt = createTestJwt(payload)
      const claims = parseJwtClaims(jwt)
      expect(claims).toEqual(payload)
    })

    test("returns undefined for JWT with less than 3 parts", () => {
      expect(parseJwtClaims("invalid")).toBeUndefined()
      expect(parseJwtClaims("only.two")).toBeUndefined()
    })

    test("returns undefined for invalid base64", () => {
      expect(parseJwtClaims("a.!!!invalid!!!.b")).toBeUndefined()
    })

    test("returns undefined for invalid JSON payload", () => {
      const header = Buffer.from("{}").toString("base64url")
      const invalidJson = Buffer.from("not json").toString("base64url")
      expect(parseJwtClaims(`${header}.${invalidJson}.sig`)).toBeUndefined()
    })
  })

  describe("extractAccountIdFromClaims", () => {
    test("extracts chatgpt_account_id from root", () => {
      const claims: IdTokenClaims = { chatgpt_account_id: "acc-root" }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-root")
    })

    test("extracts chatgpt_account_id from nested https://api.openai.com/auth", () => {
      const claims: IdTokenClaims = {
        "https://api.openai.com/auth": { chatgpt_account_id: "acc-nested" },
      }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-nested")
    })

    test("prefers root over nested", () => {
      const claims: IdTokenClaims = {
        chatgpt_account_id: "acc-root",
        "https://api.openai.com/auth": { chatgpt_account_id: "acc-nested" },
      }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-root")
    })

    test("extracts from organizations array as fallback", () => {
      const claims: IdTokenClaims = {
        organizations: [{ id: "org-123" }, { id: "org-456" }],
      }
      expect(extractAccountIdFromClaims(claims)).toBe("org-123")
    })

    test("returns undefined when no accountId found", () => {
      const claims: IdTokenClaims = { email: "test@example.com" }
      expect(extractAccountIdFromClaims(claims)).toBeUndefined()
    })
  })

  describe("extractAccountId", () => {
    test("extracts from id_token first", () => {
      const idToken = createTestJwt({ chatgpt_account_id: "from-id-token" })
      const accessToken = createTestJwt({ chatgpt_account_id: "from-access-token" })
      expect(
        extractAccountId({
          id_token: idToken,
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("from-id-token")
    })

    test("falls back to access_token when id_token has no accountId", () => {
      const idToken = createTestJwt({ email: "test@example.com" })
      const accessToken = createTestJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "from-access" },
      })
      expect(
        extractAccountId({
          id_token: idToken,
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("from-access")
    })

    test("returns undefined when no tokens have accountId", () => {
      const token = createTestJwt({ email: "test@example.com" })
      expect(
        extractAccountId({
          id_token: token,
          access_token: token,
          refresh_token: "rt",
        }),
      ).toBeUndefined()
    })

    test("handles missing id_token", () => {
      const accessToken = createTestJwt({ chatgpt_account_id: "acc-123" })
      expect(
        extractAccountId({
          id_token: "",
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("acc-123")
    })
  })

  test("installs websocket transport only when experimental websockets are enabled", async () => {
    const disabled = await CodexAuthPlugin({} as never)
    const enabled = await CodexAuthPlugin({} as never, { experimentalWebSockets: true })

    const disabledOptions = await disabled.auth!.loader!(
      async () => ({ type: "api", key: "sk-test" }) as never,
      {} as never,
    )
    const enabledOptions = await enabled.auth!.loader!(
      async () => ({ type: "api", key: "sk-test" }) as never,
      {} as never,
    )

    expect(disabledOptions.fetch).toBeUndefined()
    expect(enabledOptions.fetch).toBeFunction()
    await enabled.dispose?.()
  })

  test("deduplicates concurrent Codex token refreshes", async () => {
    let auth = {
      type: "oauth" as const,
      refresh: "refresh-old",
      access: "",
      expires: 0,
    }
    const authUpdates: Array<{
      body: { refresh: string; access: string; expires: number; accountId?: string }
    }> = []
    let resolveRefresh: (() => void) | undefined
    const refreshReady = new Promise<void>((resolve) => {
      resolveRefresh = resolve
    })
    let refreshRequests = 0
    const apiRequests: { authorization: string | null; accountId: string | null }[] = []

    using server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/oauth/token") {
          expect(await request.text()).toContain("refresh_token=refresh-old")
          refreshRequests += 1
          await refreshReady
          return Response.json({
            id_token: createTestJwt({ chatgpt_account_id: "acc-123" }),
            access_token: "access-new",
            refresh_token: "refresh-new",
            expires_in: 3600,
          })
        }

        if (url.pathname === "/backend-api/codex/responses") {
          apiRequests.push({
            authorization: request.headers.get("authorization"),
            accountId: request.headers.get("ChatGPT-Account-Id"),
          })
          return new Response("{}", { status: 200 })
        }

        return new Response("unexpected request", { status: 500 })
      },
    })

    const hooks = await CodexAuthPlugin(
      {
        client: {
          auth: {
            async set(input: { body: { refresh: string; access: string; expires: number; accountId?: string } }) {
              authUpdates.push(input)
              auth = {
                type: "oauth",
                refresh: input.body.refresh,
                access: input.body.access,
                expires: input.body.expires,
                ...(input.body.accountId && { accountId: input.body.accountId }),
              }
            },
          },
        } as never,
        project: {} as never,
        directory: "",
        worktree: "",
        experimental_workspace: {
          register() {},
        },
        serverUrl: new URL("https://example.com"),
        $: {} as never,
      },
      {
        issuer: server.url.origin,
        codexApiEndpoint: new URL("/backend-api/codex/responses", server.url).toString(),
      },
    )
    const loaded = await hooks.auth!.loader!(async () => auth as never, {} as never)

    const first = loaded.fetch!("https://api.openai.com/v1/responses")
    const second = loaded.fetch!("https://api.openai.com/v1/responses")

    await waitFor(() => refreshRequests === 1)
    expect(apiRequests).toHaveLength(0)

    resolveRefresh!()
    await Promise.all([first, second])

    expect(refreshRequests).toBe(1)
    expect(authUpdates).toHaveLength(1)
    expect(authUpdates[0]?.body.refresh).toBe("refresh-new")
    expect(authUpdates[0]?.body.access).toBe("access-new")
    expect(authUpdates[0]?.body.accountId).toBe("acc-123")
    expect(apiRequests).toEqual([
      { authorization: "Bearer access-new", accountId: "acc-123" },
      { authorization: "Bearer access-new", accountId: "acc-123" },
    ])
  })

  describe("provider models hook", () => {
    function testModel(id: string, options: Record<string, unknown> = {}) {
      return {
        id,
        providerID: "openai",
        api: { id, url: "", npm: "@ai-sdk/openai" },
        name: id,
        options,
        cost: { input: 10, output: 50, cache: { read: 1, write: 12.5 } },
        limit: { context: 1_050_000, input: 922_000, output: 128_000 },
      }
    }

    const MODEL_IDS = [
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6",
      "gpt-5.6-sol",
      "gpt-5.5",
      "gpt-5.5-pro",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
      "gpt-5.3-codex",
      "gpt-5.2",
      "gpt-5",
      "o3",
    ]

    async function runModelsHook(ctx: unknown) {
      const hooks = await CodexAuthPlugin({} as never)
      const provider = {
        id: "openai",
        name: "OpenAI",
        source: "env",
        env: [],
        options: {},
        models: {
          ...Object.fromEntries(MODEL_IDS.map((id) => [id, testModel(id)])),
          "gpt-6-terra": testModel("gpt-6-terra", { reasoningMode: "pro" }),
        },
      }
      return hooks.provider!.models!(provider as never, ctx as never)
    }

    test("includes gpt-6 family and post-5.4 models for oauth", async () => {
      const models = await runModelsHook({
        auth: { type: "oauth", refresh: "r", access: "a", expires: Date.now() + 60_000 },
      })
      const keys = Object.keys(models)
      expect(keys).toContain("gpt-6-astra")
      expect(keys).toContain("gpt-6-sol")
      expect(keys).toContain("gpt-6-luna")
      expect(keys).toContain("gpt-5.6-sol")
      expect(keys).toContain("gpt-5.5")
      expect(keys).toContain("gpt-5.4")
      expect(keys).toContain("gpt-5.4-mini")
      expect(keys).toContain("gpt-5.3-codex-spark")
    })

    test("excludes pro, allowlist-miss, and pre-5.4 models for oauth", async () => {
      const models = await runModelsHook({
        auth: { type: "oauth", refresh: "r", access: "a", expires: Date.now() + 60_000 },
      })
      const keys = Object.keys(models)
      expect(keys).not.toContain("gpt-6-terra")
      expect(keys).not.toContain("gpt-5.6")
      expect(keys).not.toContain("gpt-5.5-pro")
      expect(keys).not.toContain("gpt-5.3-codex")
      expect(keys).not.toContain("gpt-5.2")
      expect(keys).not.toContain("gpt-5")
      expect(keys).not.toContain("o3")
    })

    test("zeroes cost and overrides gpt-5.5/gpt-5.6 limits for oauth", async () => {
      const models = await runModelsHook({
        auth: { type: "oauth", refresh: "r", access: "a", expires: Date.now() + 60_000 },
      })
      expect(models["gpt-6-astra"]!.cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } })
      expect(models["gpt-6-astra"]!.limit.context).toBe(1_050_000)
      expect(models["gpt-5.5"]!.limit).toEqual({ context: 400_000, input: 272_000, output: 128_000 })
      expect(models["gpt-5.6-sol"]!.limit).toEqual({ context: 400_000, input: 272_000, output: 128_000 })
    })

    test("returns all models unchanged for api key auth", async () => {
      const models = await runModelsHook({ auth: { type: "api", key: "sk-test" } })
      expect(Object.keys(models)).toHaveLength(MODEL_IDS.length + 1)
      expect(models["gpt-5"]!.cost.input).toBe(10)
    })
  })
})

async function waitFor(predicate: () => boolean) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 1_000) throw new Error("timed out waiting for condition")
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}
