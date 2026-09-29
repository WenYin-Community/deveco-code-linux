import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { AppRuntime } from "@/effect/app-runtime"
import { LoginCancelledError, UnsupportedRegionError } from "@/plugin/deveco/errors"
import type { CallbackData, HttpResponse, TokenCheckResponse } from "@/plugin/deveco/types"

let mockServerInstance: {
  start: () => Promise<number>
  waitForCallback: (timeout: number) => Promise<CallbackData>
  stop: () => Promise<void>
  cancel: () => void
  getPort: () => number
}

let mockSaveAuthToDisk: (key: string, info: Record<string, unknown> | null) => Promise<void>
let mockOpenLoginPageShouldFail = false

const localAuthServer = await import("@/plugin/deveco/local-auth-server")
const storage = await import("@/plugin/deveco/storage")
const localAuthServerStartSpy = spyOn(localAuthServer.LocalAuthServer.prototype, "start")
const localAuthServerWaitForCallbackSpy = spyOn(localAuthServer.LocalAuthServer.prototype, "waitForCallback")
const localAuthServerStopSpy = spyOn(localAuthServer.LocalAuthServer.prototype, "stop")
const localAuthServerCancelSpy = spyOn(localAuthServer.LocalAuthServer.prototype, "cancel")
const localAuthServerGetPortSpy = spyOn(localAuthServer.LocalAuthServer.prototype, "getPort")
const saveAuthToDiskSpy = spyOn(storage, "saveAuthToDisk")
const appRuntimeRunPromiseSpy = spyOn(AppRuntime, "runPromise")
const { LoginService } = await import("@/plugin/deveco/login-service")
type OpenLoginPage = (port: number, loginState: string) => Promise<void>
const openLoginPageSpy = spyOn(
  LoginService.prototype as unknown as Record<"openLoginPage", OpenLoginPage>,
  "openLoginPage",
)
const { httpClient } = await import("@/plugin/deveco/http-client")
const { tokenStorage } = await import("@/plugin/deveco/token-storage")

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")
  const payloadStr = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const signature = Buffer.from("fake-signature").toString("base64url")
  return `${header}.${payloadStr}.${signature}`
}

const savedHttpClientGet = httpClient.get
const savedHttpClientParseJson = httpClient.parseJson
const savedTokenStorageSaveToken = tokenStorage.saveToken
const savedTokenStorageLoadToken = tokenStorage.loadToken
const savedTokenStorageClearToken = tokenStorage.clearToken

function makeServer(overrides?: Partial<typeof mockServerInstance>) {
  const defaults = {
    start: mock(() => Promise.resolve(12345)),
    waitForCallback: mock(() => Promise.resolve({ tempToken: "test-temp-token", siteId: "1" })),
    stop: mock(() => Promise.resolve()),
    cancel: mock(() => {}),
    getPort: mock(() => 12345),
  }
  return { ...defaults, ...overrides }
}

const defaultJwt = createJwt({ userId: "user-123", userName: "Alice" })
const defaultTokenCheck: TokenCheckResponse = {
  status: true,
  userInfo: {
    accessToken: "access-token-123",
    refreshToken: "refresh-token-456",
    nationalCode: "CN",
    realName: "true",
  },
}

function mockHttpClientForLogin(
  jwt: string = defaultJwt,
  tokenCheck: TokenCheckResponse = defaultTokenCheck,
  jwtStatus: number = 200,
  checkStatus: number = 200,
) {
  httpClient.get = mock((url: string) => {
    if (url.includes("temptoken")) {
      return Promise.resolve({ statusCode: jwtStatus, data: jwt, headers: {} } as HttpResponse)
    }
    if (url.includes("jwToken")) {
      return Promise.resolve({ statusCode: checkStatus, data: JSON.stringify(tokenCheck), headers: {} } as HttpResponse)
    }
    return Promise.resolve({ statusCode: 404, data: "", headers: {} } as HttpResponse)
  })
  httpClient.parseJson = mock(() => tokenCheck)
}

mockServerInstance = makeServer()
mockSaveAuthToDisk = mock(async () => {})

beforeEach(() => {
  mockServerInstance = makeServer()
  mockSaveAuthToDisk = mock(async () => {})
  mockOpenLoginPageShouldFail = false
  localAuthServerStartSpy.mockReset().mockImplementation(() => mockServerInstance.start())
  localAuthServerWaitForCallbackSpy
    .mockReset()
    .mockImplementation((timeout: number) => mockServerInstance.waitForCallback(timeout))
  localAuthServerStopSpy.mockReset().mockImplementation(() => mockServerInstance.stop())
  localAuthServerCancelSpy.mockReset().mockImplementation(() => mockServerInstance.cancel())
  localAuthServerGetPortSpy.mockReset().mockImplementation(() => mockServerInstance.getPort())
  saveAuthToDiskSpy
    .mockReset()
    .mockImplementation((key: string, info: Record<string, unknown> | null) => mockSaveAuthToDisk(key, info))
  appRuntimeRunPromiseSpy.mockReset().mockResolvedValue(undefined)
  openLoginPageSpy.mockReset().mockImplementation(() => {
    if (mockOpenLoginPageShouldFail) return Promise.reject(new Error("Failed to open login page"))
    return Promise.resolve()
  })
})

afterEach(() => {
  httpClient.get = savedHttpClientGet
  httpClient.parseJson = savedHttpClientParseJson
  tokenStorage.saveToken = savedTokenStorageSaveToken
  tokenStorage.loadToken = savedTokenStorageLoadToken
  tokenStorage.clearToken = savedTokenStorageClearToken
})

afterAll(() => {
  localAuthServerStartSpy.mockRestore()
  localAuthServerWaitForCallbackSpy.mockRestore()
  localAuthServerStopSpy.mockRestore()
  localAuthServerCancelSpy.mockRestore()
  localAuthServerGetPortSpy.mockRestore()
  saveAuthToDiskSpy.mockRestore()
  appRuntimeRunPromiseSpy.mockRestore()
  openLoginPageSpy.mockRestore()
})

describe("LoginService.parseJwt", () => {
  test("should parse valid JWT and extract userId, userName, exp, iat", () => {
    const service = new LoginService()
    const jwt = createJwt({ userId: "user-123", userName: "Alice", exp: 12345, iat: 67890 })
    const result = service.parseJwt(jwt)
    expect(result.userId).toBe("user-123")
    expect(result.userName).toBe("Alice")
    expect(result.exp).toBe(12345)
    expect(result.iat).toBe(67890)
  })

  test("should throw for tokens with wrong number of segments", () => {
    const service = new LoginService()
    expect(() => service.parseJwt("onlyone")).toThrow("Invalid jwtToken format")
    expect(() => service.parseJwt("header.payload")).toThrow("Invalid jwtToken format")
  })

  test("should default userId and userName to empty string when missing", () => {
    const service = new LoginService()
    const jwt = createJwt({ exp: 1 })
    const result = service.parseJwt(jwt)
    expect(result.userId).toBe("")
    expect(result.userName).toBe("")
  })
})

describe("LoginService.isLoggedIn", () => {
  test("should check persisted credentials even when userInfo is set", async () => {
    mockHttpClientForLogin()
    tokenStorage.saveToken = mock(() => Promise.resolve())
    mockServerInstance = makeServer({
      waitForCallback: mock(() => Promise.resolve({ tempToken: "test-temp-token&siteId=1", siteId: "1" })),
    })
    const service = new LoginService()
    await service.login()

    const loadSpy = mock(() => Promise.resolve("stored-jwt-token"))
    tokenStorage.loadToken = loadSpy
    expect(await service.isLoggedIn()).toBe(true)
    expect(loadSpy.mock.calls.length).toBe(1)
  })

  test("should return true when token exists in storage and userInfo is null", async () => {
    tokenStorage.loadToken = mock(() => Promise.resolve("stored-jwt-token"))
    const service = new LoginService()
    expect(await service.isLoggedIn()).toBe(true)
  })

  test("should return false when userInfo is null and no token in storage", async () => {
    tokenStorage.loadToken = mock(() => Promise.resolve(null))
    const service = new LoginService()
    expect(await service.isLoggedIn()).toBe(false)
  })
})

describe("LoginService.getUserInfo", () => {
  test("should return null when userInfo has not been set", () => {
    const service = new LoginService()
    expect(service.getUserInfo()).toBe(null)
  })
})

describe("LoginService.logout", () => {
  test("should clear token storage and call saveAuthToDisk with null", async () => {
    const clearSpy = mock(() => Promise.resolve())
    tokenStorage.clearToken = clearSpy
    const diskSpy = mock(async (key: string, info: Record<string, unknown> | null) => {
      expect(key).toBe("deveco")
      expect(info).toBe(null)
    })
    mockSaveAuthToDisk = diskSpy

    const service = new LoginService()
    await service.logout()

    expect(clearSpy.mock.calls.length).toBe(1)
    expect(service.getUserInfo()).toBe(null)
  })

  test("reports incomplete logout when saveAuthToDisk fails", async () => {
    tokenStorage.clearToken = mock(() => Promise.resolve())
    mockSaveAuthToDisk = mock(async () => {
      throw new Error("disk write failed")
    })

    const access = await import("@/plugin/deveco/access")
    const models = await import("@/plugin/deveco-models")
    const analytics = await import("@/plugin/analytics/uploader")
    const magpie = await import("@/plugin/analytics-magpie/uploader")
    const checks = [
      spyOn(access, "clearDevEcoAccess"),
      spyOn(models, "clearDevecoModelCache"),
      spyOn(analytics, "clearAnalyticsQueue"),
      spyOn(magpie, "disableAnalyticsMagpie"),
    ]
    try {
      const service = new LoginService()
      await expect(service.logout()).rejects.toThrow("disk write failed")
      expect(service.getUserInfo()).toBe(null)
      expect(tokenStorage.clearToken).toHaveBeenCalledTimes(1)
      for (const check of checks) expect(check).toHaveBeenCalledTimes(1)
    } finally {
      for (const check of checks) check.mockRestore()
    }
  })
})

describe("LoginService.cancel", () => {
  test("should do nothing when server is not initialized", () => {
    const service = new LoginService()
    service.cancel()
  })

  test("cancel aborts the in-flight callback and stops the server", async () => {
    const stopSpy = mock(() => Promise.resolve())
    let rejectCallback!: (err: Error) => void
    mockServerInstance = makeServer({
      waitForCallback: mock(
        () =>
          new Promise<CallbackData>((_, reject) => {
            rejectCallback = reject
          }),
      ),
      cancel: mock(() => {
        rejectCallback(new LoginCancelledError("cancelled by user"))
      }),
      stop: stopSpy,
    })

    const service = new LoginService()
    const loginPromise = service.login()
    // Let login reach `await callbackPromise` before cancelling
    await Bun.sleep(0)
    service.cancel()
    const result = await loginPromise

    expect(result.success).toBe(false)
    expect(result.cancelled).toBe(true)
    expect(localAuthServerCancelSpy).toHaveBeenCalledTimes(1)
    expect(stopSpy).toHaveBeenCalledTimes(1)
  })
})

describe("LoginService.login", () => {
  test("should return success result with userInfo on successful login flow", async () => {
    const stopSpy = mock(() => Promise.resolve())
    mockServerInstance = makeServer({
      waitForCallback: mock(() => Promise.resolve({ tempToken: "test-temp-token&siteId=1", siteId: "1" })),
      stop: stopSpy,
    })
    mockHttpClientForLogin()
    tokenStorage.saveToken = mock(() => Promise.resolve())

    const service = new LoginService()
    const result = await service.login()

    expect(result.success).toBe(true)
    expect(result.userInfo).toBeDefined()
    expect(result.userInfo!.userId).toBe("user-123")
    expect(result.userInfo!.userName).toBe("Alice")
    expect(result.userInfo!.accessToken).toBe("access-token-123")
    expect(result.userInfo!.refreshToken).toBe("refresh-token-456")
    expect(result.userInfo!.countryCode).toBe("CN")
    expect(result.userInfo!.language).toBe("zh_CN")
    expect(result.userInfo!.isRealName).toBe(true)
    expect(stopSpy.mock.calls.length).toBe(1)

    tokenStorage.loadToken = mock(() => Promise.resolve("stored-jwt-token"))
    expect(await service.isLoggedIn()).toBe(true)
    expect(service.getUserInfo()!.userId).toBe("user-123")
  })

  test("should reject a non-China account country", async () => {
    mockServerInstance = makeServer()
    mockHttpClientForLogin(defaultJwt, {
      ...defaultTokenCheck,
      userInfo: { ...defaultTokenCheck.userInfo!, nationalCode: "DE" },
    })
    const saveToken = mock(() => Promise.resolve())
    tokenStorage.saveToken = saveToken

    const result = await new LoginService().login()

    expect(result.success).toBe(false)
    expect(result.unsupportedRegion).toBe(true)
    expect(result.error).toBe("DevEco Code currently only supports China-region accounts.")
    expect(saveToken).not.toHaveBeenCalled()
  })

  test("should reject a missing account country", async () => {
    mockServerInstance = makeServer()
    mockHttpClientForLogin(defaultJwt, {
      ...defaultTokenCheck,
      userInfo: { ...defaultTokenCheck.userInfo!, nationalCode: "" },
    })
    tokenStorage.saveToken = mock(() => Promise.resolve())

    const result = await new LoginService().login()

    expect(result.success).toBe(false)
    expect(result.unsupportedRegion).toBe(true)
  })

  test("should return cancelled result when LoginCancelledError is thrown", async () => {
    const stopSpy = mock(() => Promise.resolve())
    mockServerInstance = makeServer({
      waitForCallback: mock(() => Promise.reject(new LoginCancelledError("user cancelled"))),
      stop: stopSpy,
    })

    const service = new LoginService()
    const result = await service.login()

    expect(result.success).toBe(false)
    expect(result.cancelled).toBe(true)
    expect(result.error).toBe("user cancelled")
    expect(stopSpy.mock.calls.length).toBe(1)
  })

  test("should return unsupportedRegion result when UnsupportedRegionError is thrown", async () => {
    const stopSpy = mock(() => Promise.resolve())
    mockServerInstance = makeServer({
      waitForCallback: mock(() => Promise.reject(new UnsupportedRegionError("Unsupported region"))),
      stop: stopSpy,
    })

    const service = new LoginService()
    const result = await service.login()

    expect(result.success).toBe(false)
    expect(result.unsupportedRegion).toBe(true)
    expect(result.error).toBe("DevEco Code currently only supports China-region accounts.")
    expect(stopSpy.mock.calls.length).toBe(1)
  })

  test("should return error result when server start fails", async () => {
    mockServerInstance = makeServer({
      start: mock(() => Promise.reject(new Error("port in use"))),
    })

    const service = new LoginService()
    const result = await service.login()

    expect(result.success).toBe(false)
    expect(result.cancelled).toBeUndefined()
    expect(result.unsupportedRegion).toBeUndefined()
    expect(result.error).toBe("port in use")
  })

  test("should return error result when getJwtToken returns non-200 status", async () => {
    mockHttpClientForLogin(defaultJwt, defaultTokenCheck, 500, 200)

    const service = new LoginService()
    const result = await service.login()

    expect(result.success).toBe(false)
    expect(result.error).toBe("Failed to get jwtToken: 500")
  })

  test("should return error result when getJwtToken returns invalid JWT format", async () => {
    mockHttpClientForLogin("not-a-jwt", defaultTokenCheck)

    const service = new LoginService()
    const result = await service.login()

    expect(result.success).toBe(false)
    expect(result.error).toBe("Invalid jwtToken format")
  })

  test("should return error result when checkJwtToken returns non-200 status", async () => {
    mockHttpClientForLogin(defaultJwt, defaultTokenCheck, 200, 403)

    const service = new LoginService()
    const result = await service.login()

    expect(result.success).toBe(false)
    expect(result.error).toBe("Failed to check jwtToken: 403")
  })

  test("should return error result when checkJwtToken response has status false", async () => {
    mockHttpClientForLogin(defaultJwt, { status: false })

    const service = new LoginService()
    const result = await service.login()

    expect(result.success).toBe(false)
    expect(result.error).toBe("Invalid jwtToken: missing userInfo")
  })

  test("should return error result when checkJwtToken response has no userInfo", async () => {
    mockHttpClientForLogin(defaultJwt, { status: true })

    const service = new LoginService()
    const result = await service.login()

    expect(result.success).toBe(false)
    expect(result.error).toBe("Invalid jwtToken: missing userInfo")
  })

  test("should return error result and stop server when openLoginPage fails", async () => {
    mockOpenLoginPageShouldFail = true
    const stopSpy = mock(() => Promise.resolve())
    mockServerInstance = makeServer({ stop: stopSpy })
    mockHttpClientForLogin()
    tokenStorage.saveToken = mock(() => Promise.resolve())

    const service = new LoginService()
    const result = await service.login()

    expect(result.success).toBe(false)
    expect(result.error).toBe("Failed to open login page")
    expect(stopSpy.mock.calls.length).toBe(1)
  })

  test("should stop server in finally block even when login fails", async () => {
    const stopSpy = mock(() => Promise.resolve())
    mockServerInstance = makeServer({
      waitForCallback: mock(() => Promise.reject(new Error("timeout"))),
      stop: stopSpy,
    })

    const service = new LoginService()
    await service.login()

    expect(stopSpy.mock.calls.length).toBe(1)
  })
})

describe("LoginService network failure messaging", () => {
  test("explains a DNS failure instead of surfacing getaddrinfo", async () => {
    const dns = new Error("getaddrinfo ENOTFOUND cn.devecostudio.huawei.com") as Error & { code?: string }
    dns.code = "ENOTFOUND"
    httpClient.get = mock(() => Promise.reject(dns))

    const result = await new LoginService().login()

    expect(result.success).toBe(false)
    expect(result.error).toContain("Cannot resolve the address of cn.devecostudio.huawei.com")
    expect(result.error).toContain("HTTPS_PROXY")
  })

  test("keeps non-network errors verbatim", async () => {
    httpClient.get = mock(() => Promise.reject(new Error("Invalid jwtToken format")))

    const result = await new LoginService().login()

    expect(result.success).toBe(false)
    expect(result.error).toBe("Invalid jwtToken format")
  })

  test("keeps the gateway HTML diagnostic instead of blaming the proxy", async () => {
    httpClient.get = mock((url: string) => {
      if (url.includes("temptoken")) {
        return Promise.resolve({ statusCode: 200, data: defaultJwt, headers: {} } as HttpResponse)
      }
      return Promise.resolve({
        statusCode: 200,
        data: "<html>blocked by gateway</html>",
        headers: { "content-type": "text/html" },
      } as HttpResponse)
    })

    const result = await new LoginService().login()

    expect(result.success).toBe(false)
    expect(result.error).toContain("Server returned HTML instead of JSON")
    expect(result.error).not.toContain("HTTPS_PROXY")
  })
})

describe("LoginService.checkAccountRegion", () => {
  test("returns supported only for a CN nationalCode", async () => {
    mockHttpClientForLogin(defaultJwt, defaultTokenCheck)
    expect(await new LoginService().checkAccountRegion(defaultJwt)).toBe("supported")
  })

  test("returns unsupported for a non-CN nationalCode", async () => {
    mockHttpClientForLogin(defaultJwt, {
      ...defaultTokenCheck,
      userInfo: { ...defaultTokenCheck.userInfo!, nationalCode: "FR" },
    })
    expect(await new LoginService().checkAccountRegion(defaultJwt)).toBe("unsupported")
  })

  test("returns unverified when the token check fails", async () => {
    httpClient.get = mock(() => Promise.reject(new Error("offline")))
    expect(await new LoginService().checkAccountRegion(defaultJwt)).toBe("unverified")
  })
})

describe("LoginService.refreshToken", () => {
  test("should return new tokens on successful refresh", async () => {
    const tokenCheck: TokenCheckResponse = {
      status: true,
      userInfo: {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        nationalCode: "CN",
        realName: "false",
      },
    }
    httpClient.get = mock(() =>
      Promise.resolve({
        statusCode: 200,
        data: JSON.stringify(tokenCheck),
        headers: {},
      } as HttpResponse),
    )
    httpClient.parseJson = mock(() => tokenCheck)

    const service = new LoginService()
    const result = await service.refreshToken("some.jwt.token")

    expect(result).not.toBe(null)
    expect(result!.accessToken).toBe("new-access")
    expect(result!.refreshToken).toBe("new-refresh")
  })

  test("should return null when HTTP response status is not 200", async () => {
    httpClient.get = mock(() =>
      Promise.resolve({
        statusCode: 403,
        data: "",
        headers: {},
      } as HttpResponse),
    )

    const service = new LoginService()
    expect(await service.refreshToken("some.jwt.token")).toBe(null)
  })

  test("should return null when response has status false", async () => {
    const invalidResponse: TokenCheckResponse = { status: false }
    httpClient.get = mock(() =>
      Promise.resolve({
        statusCode: 200,
        data: JSON.stringify(invalidResponse),
        headers: {},
      } as HttpResponse),
    )
    httpClient.parseJson = mock(() => invalidResponse)

    const service = new LoginService()
    expect(await service.refreshToken("some.jwt.token")).toBe(null)
  })

  test("should return null when response has status true but no userInfo", async () => {
    const noUserInfo: TokenCheckResponse = { status: true }
    httpClient.get = mock(() =>
      Promise.resolve({
        statusCode: 200,
        data: JSON.stringify(noUserInfo),
        headers: {},
      } as HttpResponse),
    )
    httpClient.parseJson = mock(() => noUserInfo)

    const service = new LoginService()
    expect(await service.refreshToken("some.jwt.token")).toBe(null)
  })

  test("should return null when httpClient.get throws", async () => {
    httpClient.get = mock(() => Promise.reject(new Error("network error")))

    const service = new LoginService()
    expect(await service.refreshToken("some.jwt.token")).toBe(null)
  })

  test("should default refreshToken to empty string when missing", async () => {
    const response: TokenCheckResponse = {
      status: true,
      userInfo: {
        accessToken: "access-only",
        nationalCode: "CN",
        realName: "false",
      },
    }
    httpClient.get = mock(() =>
      Promise.resolve({
        statusCode: 200,
        data: JSON.stringify(response),
        headers: {},
      } as HttpResponse),
    )
    httpClient.parseJson = mock(() => response)

    const service = new LoginService()
    const result = await service.refreshToken("some.jwt.token")

    expect(result!.accessToken).toBe("access-only")
    expect(result!.refreshToken).toBe("")
  })

  test("should throw UnsupportedRegionError when nationalCode is not CN", async () => {
    const nonChinaResponse: TokenCheckResponse = {
      status: true,
      userInfo: {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        nationalCode: "US",
        realName: "true",
      },
    }
    httpClient.get = mock(() =>
      Promise.resolve({
        statusCode: 200,
        data: JSON.stringify(nonChinaResponse),
        headers: {},
      } as HttpResponse),
    )
    httpClient.parseJson = mock(() => nonChinaResponse)

    const service = new LoginService()
    expect(() => service.refreshToken("some.jwt.token")).toThrow(UnsupportedRegionError)
  })
})

describe("LoginService.checkRealNameWithToken", () => {
  test("should return verified=true with tokens when server reports realName as 'true'", async () => {
    const tokenCheck: TokenCheckResponse = {
      status: true,
      userInfo: {
        accessToken: "fresh-access",
        refreshToken: "fresh-refresh",
        nationalCode: "CN",
        realName: "true",
      },
    }
    httpClient.get = mock(() =>
      Promise.resolve({ statusCode: 200, data: JSON.stringify(tokenCheck), headers: {} } as HttpResponse),
    )
    httpClient.parseJson = mock(() => tokenCheck)

    const service = new LoginService()
    const result = await service.checkRealNameWithToken("some.jwt.token")

    expect(result.verified).toBe(true)
    expect(result.accessToken).toBe("fresh-access")
    expect(result.refreshToken).toBe("fresh-refresh")
  })

  test("should return verified=false when server reports realName as 'false'", async () => {
    const tokenCheck: TokenCheckResponse = {
      status: true,
      userInfo: {
        accessToken: "fresh-access",
        refreshToken: "fresh-refresh",
        nationalCode: "CN",
        realName: "false",
      },
    }
    httpClient.get = mock(() =>
      Promise.resolve({ statusCode: 200, data: JSON.stringify(tokenCheck), headers: {} } as HttpResponse),
    )
    httpClient.parseJson = mock(() => tokenCheck)

    const service = new LoginService()
    const result = await service.checkRealNameWithToken("some.jwt.token")

    expect(result.verified).toBe(false)
    expect(result.accessToken).toBe("fresh-access")
  })

  test("should throw when response is incomplete (missing accessToken)", async () => {
    const tokenCheck: TokenCheckResponse = {
      status: true,
      userInfo: {
        accessToken: "",
        nationalCode: "CN",
        realName: "true",
      },
    }
    httpClient.get = mock(() =>
      Promise.resolve({ statusCode: 200, data: JSON.stringify(tokenCheck), headers: {} } as HttpResponse),
    )
    httpClient.parseJson = mock(() => tokenCheck)

    const service = new LoginService()
    expect(() => service.checkRealNameWithToken("some.jwt.token")).toThrow("incomplete")
  })

  test("should send refresh=true header to get latest real-name status from server", async () => {
    const tokenCheck: TokenCheckResponse = {
      status: true,
      userInfo: {
        accessToken: "fresh-access",
        refreshToken: "fresh-refresh",
        nationalCode: "CN",
        realName: "true",
      },
    }
    let capturedConfig: { headers?: Record<string, string> } | undefined
    const getSpy = mock((url: string, config?: { headers?: Record<string, string> }) => {
      capturedConfig = config
      return Promise.resolve({ statusCode: 200, data: JSON.stringify(tokenCheck), headers: {} } as HttpResponse)
    })
    httpClient.get = getSpy
    httpClient.parseJson = mock(() => tokenCheck)

    const service = new LoginService()
    await service.checkRealNameWithToken("some.jwt.token")

    expect(getSpy).toHaveBeenCalled()
    expect(capturedConfig?.headers).toEqual(
      expect.objectContaining({ refresh: "true" }),
    )
  })

  test("should default refreshToken to empty string when missing", async () => {
    const tokenCheck: TokenCheckResponse = {
      status: true,
      userInfo: {
        accessToken: "fresh-access",
        nationalCode: "CN",
        realName: "true",
      },
    }
    httpClient.get = mock(() =>
      Promise.resolve({ statusCode: 200, data: JSON.stringify(tokenCheck), headers: {} } as HttpResponse),
    )
    httpClient.parseJson = mock(() => tokenCheck)

    const service = new LoginService()
    const result = await service.checkRealNameWithToken("some.jwt.token")

    expect(result.refreshToken).toBe("")
  })
})
