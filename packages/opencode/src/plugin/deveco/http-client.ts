import type { HttpRequestConfig, HttpResponse, TokenCheckResponse } from "./types"

export class HttpClient {
  private defaultTimeout: number = 20000
  private defaultHeaders: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "accept-language": "zh-CN",
  }

  public async get(url: string, config?: HttpRequestConfig): Promise<HttpResponse> {
    return this.request(url, "GET", config)
  }

  public async post(url: string, config?: HttpRequestConfig): Promise<HttpResponse> {
    return this.request(url, "POST", config)
  }

  // Uses fetch instead of node:http/https on purpose: Bun's fetch honours
  // HTTP(S)_PROXY / NO_PROXY, while node's request ignores them. Behind a
  // corporate proxy the browser completed OAuth but the token exchange died
  // with `getaddrinfo ENOTFOUND cn.devecostudio.huawei.com`.
  private async request(url: string, method: string, config?: HttpRequestConfig): Promise<HttpResponse> {
    const searchParams = new URLSearchParams(config?.params ?? {})
    const queryString = searchParams.toString()
    const fullUrl = queryString ? `${url}?${queryString}` : url
    const body = method === "POST" && config?.params ? JSON.stringify(config.params) : undefined

    try {
      const response = await fetch(fullUrl, {
        method,
        headers: { ...this.defaultHeaders, ...(config?.headers ?? {}) },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(config?.timeout ?? this.defaultTimeout),
      })

      const headers: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        headers[key] = value
      })

      return {
        data: await response.text(),
        statusCode: response.status,
        headers,
      }
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new Error("Request timeout", { cause: err })
      }
      throw err
    }
  }

  public parseJson(response: HttpResponse): TokenCheckResponse {
    const contentType = (response.headers["content-type"] ?? "").toString().toLowerCase()
    const body = response.data.trim()
    if (contentType.includes("html") || /^\s*<!doctype|^\s*<html/i.test(body)) {
      throw new Error(
        `Server returned HTML instead of JSON (content-type: ${contentType || "unknown"}). The auth server may be behind a gateway or proxy error page.`,
      )
    }
    try {
      return JSON.parse(body) as TokenCheckResponse
    } catch (err) {
      throw new Error(
        `Failed to parse server response as JSON: ${err instanceof Error ? err.message : String(err)}. Response preview: ${body.slice(0, 200)}`,
      )
    }
  }
}

export const httpClient = new HttpClient()
