import crypto from "crypto"
import open from "open"
import { logInfo, logWarn, logError } from "./log"
import { LoginCancelledError, UnsupportedRegionError } from "./errors"
import { httpClient } from "./http-client"
import { LocalAuthServer } from "./local-auth-server"
import { tokenStorage } from "./token-storage"
import { saveAuthToDisk } from "./storage"
import type { AccountRegionStatus, JwtPayload, LoginConfig, LoginResult, TokenCheckResponse, UserInfo } from "./types"
import { DEFAULT_CONFIG } from "./types"
import { CHINA_ACCOUNT_ONLY_MESSAGE } from "./region-policy"

export class LoginService {
  private config: LoginConfig
  private server: LocalAuthServer | null = null
  private userInfo: UserInfo | null = null

  constructor(config?: Partial<LoginConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  public async login(): Promise<LoginResult> {
    try {
      const loginState = this.generateLoginState()

      this.server = new LocalAuthServer(
        this.config.defaultPort,
        loginState,
        this.config.baseUrl,
        this.config.successRedirectUrl,
        this.config.failedRedirectUrl,
      )
      await this.server.start()

      // Set up the callback promise BEFORE opening the browser page so that
      // resolveCallback/rejectCallback are ready the instant the server starts
      // receiving requests.  If the browser redirects back quickly (e.g. cached
      // OAuth session, auto-approve), the callback must not arrive before the
      // promise handlers are installed — otherwise ?. silently drops it.
      const callbackPromise = this.server.waitForCallback(this.config.timeout)

      await this.openLoginPage(this.server.getPort(), loginState)

      const callbackData = await callbackPromise

      const jwtToken = await this.getJwtToken(callbackData.tempToken)

      const userInfo = await this.getUserInfoFromJwt(jwtToken)

      await tokenStorage.saveToken(jwtToken)

      this.userInfo = userInfo

      logInfo("login succeeded", { service: "deveco" })

      return {
        success: true,
        userInfo,
      }
    } catch (err) {
      if (err instanceof LoginCancelledError) {
        logInfo("login cancelled by user", { service: "deveco" })
        return {
          success: false,
          cancelled: true,
          error: err.message,
        }
      }
      if (err instanceof UnsupportedRegionError) {
        logError("login failed: unsupported region", { service: "deveco", error: err.message })
        return {
          success: false,
          unsupportedRegion: true,
          error: CHINA_ACCOUNT_ONLY_MESSAGE,
        }
      }
      logError("login failed", { service: "deveco", error: err instanceof Error ? err.message : String(err) })
      return {
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
      }
    } finally {
      if (this.server) {
        await this.server.stop()
        this.server = null
      }
    }
  }

  public cancel(): void {
    if (this.server) {
      this.server.cancel()
    }
  }

  public async isLoggedIn(): Promise<boolean> {
    if (this.userInfo) {
      return true
    }
    const token = await tokenStorage.loadToken()
    return token !== null
  }

  public getUserInfo(): UserInfo | null {
    return this.userInfo
  }

  public async logout(): Promise<void> {
    await tokenStorage.clearToken()
    this.userInfo = null
    try {
      await saveAuthToDisk("deveco", null)
    } catch (err) {
      logWarn("failed to clear auth.json deveco entry during logout", { service: "deveco", error: String(err) })
    }
    logInfo("logout succeeded", { service: "deveco" })
  }

  // Generates a one-time CSRF nonce (OAuth `state`).
  // Renamed from `generateClientSecret` to avoid confusion with OAuth client credentials.
  private generateLoginState(): string {
    return crypto.randomUUID().replace(/-/g, "")
  }

  private async openLoginPage(port: number, loginState: string): Promise<void> {
    // `code` is the OAuth state parameter echoed back on /callback redirect.
    // Value is a CSRF nonce, not an OAuth client_secret — renamed from `clientSecret`.
    const loginUrl = `${this.config.baseUrl}/${this.config.authUrl}?port=${port}&appid=${this.config.appId}&code=${loginState}`
    const safeUrl = loginUrl.replace(/code=[^&]*/g, "code=***")

    // Allowlist the canonicalized href: `new URL` leaves `$`/backtick, which
    // stay active in the Windows launcher's PowerShell `Start "..."` string.
    let parsed: URL
    try {
      parsed = new URL(loginUrl)
    } catch (err) {
      logError("invalid login URL", { service: "deveco", url: safeUrl })
      throw new Error("Invalid login URL", { cause: err })
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      logError("unsupported login URL scheme", { service: "deveco", scheme: parsed.protocol, url: safeUrl })
      throw new Error(`Unsupported login URL scheme: ${parsed.protocol}`)
    }
    if (!/^[A-Za-z0-9._~:/?=&%#@+-]+$/.test(parsed.href)) {
      logError("login URL contains disallowed characters", { service: "deveco", url: safeUrl })
      throw new Error("Login URL contains disallowed characters")
    }

    try {
      await open(parsed.href)
    } catch (err) {
      logError("failed to open login page in browser", {
        service: "deveco",
        error: err instanceof Error ? err.message : String(err),
      })
      throw new Error("Failed to open login page", { cause: err })
    }
  }

  private async getJwtToken(tempToken: string): Promise<string> {
    const actualTempToken = tempToken.split("&")[0]

    const params = {
      tempToken: actualTempToken,
      site: "CN",
      version: "1.0.0",
      appid: this.config.appId,
    }

    const url = `${this.config.baseUrl}/${this.config.tempTokenCheckUrl}`
    const response = await httpClient.get(url, { params })

    if (response.statusCode !== 200) {
      logError("failed to get jwtToken", { service: "deveco", statusCode: response.statusCode })
      throw new Error(`Failed to get jwtToken: ${response.statusCode}`)
    }

    const jwtToken = response.data.trim()

    if (jwtToken.split(".").length !== 3) {
      logError("invalid jwtToken format received", { service: "deveco", tokenLength: jwtToken.length })
      throw new Error(`Invalid jwtToken format`)
    }

    return jwtToken
  }

  private async getUserInfoFromJwt(jwtToken: string): Promise<UserInfo> {
    const tokenInfo = await this.checkJwtToken(jwtToken)

    if (!tokenInfo.status || !tokenInfo.userInfo || !tokenInfo.userInfo.accessToken) {
      logError("invalid jwtToken: missing userInfo or accessToken", { service: "deveco", status: tokenInfo.status })
      throw new Error("Invalid jwtToken: missing userInfo")
    }

    this.requireChinaAccount(tokenInfo)

    const JwtPayload = this.parseJwt(jwtToken)

    const userInfo: UserInfo = {
      userId: JwtPayload.userId,
      userName: JwtPayload.userName,
      accessToken: tokenInfo.userInfo.accessToken,
      refreshToken: tokenInfo.userInfo.refreshToken ?? "",
      jwtToken: jwtToken,
      countryCode: tokenInfo.userInfo.nationalCode.trim().toUpperCase(),
      language: "zh_CN",
      isRealName: String(tokenInfo.userInfo.realName) === "true",
    }

    return userInfo
  }

  private async checkJwtToken(jwtToken: string, refresh = false): Promise<TokenCheckResponse> {
    const headers = {
      refresh: refresh ? "true" : "false",
      jwtToken: jwtToken,
    }

    const url = `${this.config.baseUrl}/${this.config.jwtTokenCheckUrl}`
    const response = await httpClient.get(url, { headers })

    if (response.statusCode !== 200) {
      logError("failed to check jwtToken", { service: "deveco", statusCode: response.statusCode })
      throw new Error(`Failed to check jwtToken: ${response.statusCode}`)
    }

    try {
      return httpClient.parseJson(response)
    } catch (err) {
      throw new Error(
        `Invalid response from auth server during token check: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  public async checkAccountRegion(jwtToken: string): Promise<AccountRegionStatus> {
    const tokenInfo = await this.checkJwtToken(jwtToken).catch(() => null)
    if (!tokenInfo?.status || !tokenInfo.userInfo) return "unverified"
    return tokenInfo.userInfo.nationalCode?.trim().toUpperCase() === "CN" ? "supported" : "unsupported"
  }

  public parseJwt(token: string): JwtPayload {
    const parts = token.split(".")
    if (parts.length !== 3) {
      throw new Error(`Invalid jwtToken format`)
    }

    const payload = parts[1]
    const base64Url = payload.replace(/-/g, "+").replace(/_/g, "/")
    const base64 = base64Url.padEnd(base64Url.length + ((4 - (base64Url.length % 4)) % 4), "=")
    const json = Buffer.from(base64, "base64").toString("utf8")

    const parsed = JSON.parse(json)
    return {
      userId: parsed.userId ?? "",
      userName: parsed.userName ?? "",
      exp: parsed.exp,
      iat: parsed.iat,
    }
  }

  /**
   * 刷新 accessToken
   * @param jwtToken 当前的 jwtToken
   * @returns 新的 accessToken 和 refreshToken，如果失败返回 null
   */
  async refreshToken(
    jwtToken: string,
  ): Promise<{ accessToken: string; refreshToken: string; isRealName: boolean } | null> {
    const url = `${this.config.baseUrl}/${this.config.jwtTokenCheckUrl}`
    try {
      const headers: Record<string, string> = {
        refresh: "true",
        jwtToken: jwtToken,
      }

      const response = await httpClient.get(url, { headers })

      if (response.statusCode !== 200) {
        logError(`refreshToken failed: HTTP ${response.statusCode}`, { service: "deveco", url })
        return null
      }

      const result = httpClient.parseJson(response)
      if (!result.status || !result.userInfo || !result.userInfo.accessToken) {
        logError(`refreshToken failed: invalid response`, {
          service: "deveco",
          status: result.status,
          hasUserInfo: !!result.userInfo,
          url,
        })
        return null
      }

      this.requireChinaAccount(result)

      return {
        accessToken: result.userInfo.accessToken,
        refreshToken: result.userInfo.refreshToken ?? "",
        isRealName: String(result.userInfo.realName) === "true",
      }
    } catch (err) {
      if (err instanceof UnsupportedRegionError) throw err
      logError(`refreshToken error: ${err}`, { service: "deveco", url })
      return null
    }
  }

  /**
   * Reconstruct userInfo from a refresh response and the existing JWT.
   * Used on cold start when no userInfo is in memory but a token refresh succeeded.
   */
  setUserInfoFromTokens(
    tokens: { accessToken: string; refreshToken: string; isRealName: boolean },
    jwtToken: string,
  ): void {
    const parsed = this.parseJwt(jwtToken)
    this.userInfo = {
      userId: parsed.userId,
      userName: parsed.userName ?? "",
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      jwtToken,
      countryCode: "",
      language: "",
      isRealName: tokens.isRealName,
    }
  }

  /**
   * Check real-name verification status and return fresh tokens from the API response.
   * @throws when the network request fails, the server returns a non-200 response, or the response is incomplete
   */
  async checkRealNameWithToken(
    jwtToken: string,
  ): Promise<{ verified: boolean; accessToken: string; refreshToken: string }> {
    // Use refresh=true so the server re-queries the account service for the
    // latest real-name status. With refresh=false the server returns the
    // userInfo cached at JWT issuance time, which still shows realName=false
    // even after the user completes real-name authentication in the browser.
    const tokenInfo = await this.checkJwtToken(jwtToken, true)
    if (!tokenInfo?.status || !tokenInfo.userInfo || !tokenInfo.userInfo.accessToken) {
      throw new Error("Server returned an incomplete response. Please try again later.")
    }
    this.requireChinaAccount(tokenInfo)
    return {
      verified: String(tokenInfo.userInfo.realName) === "true",
      accessToken: tokenInfo.userInfo.accessToken,
      refreshToken: tokenInfo.userInfo.refreshToken ?? "",
    }
  }

  private requireChinaAccount(tokenInfo: TokenCheckResponse): void {
    if (tokenInfo.userInfo?.nationalCode?.trim().toUpperCase() === "CN") return
    logError("unsupported account region", {
      service: "deveco",
      nationalCode: tokenInfo.userInfo?.nationalCode ?? "",
    })
    throw new UnsupportedRegionError("Unsupported account region")
  }
}

export const loginService = new LoginService()
