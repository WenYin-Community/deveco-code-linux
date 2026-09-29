import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test"
import { httpClient } from "@/plugin/deveco/http-client"

const fetchSpy = spyOn(globalThis, "fetch")
const timeoutSpy = spyOn(AbortSignal, "timeout")

const AUTH_URL = "https://cn.devecostudio.huawei.com/authrouter/auth/api/jwToken/check"

function jsonResponse(body: string, init?: ResponseInit) {
  return new Response(body, { status: 200, headers: { "content-type": "application/json" }, ...init })
}

function lastCall() {
  const call = fetchSpy.mock.calls.at(-1)
  if (!call) throw new Error("fetch was not called")
  return { url: String(call[0]), init: call[1] ?? {} }
}

afterEach(() => {
  fetchSpy.mockReset()
  timeoutSpy.mockClear()
})

afterAll(() => {
  fetchSpy.mockRestore()
  timeoutSpy.mockRestore()
})

describe("httpClient", () => {
  // Bun applies HTTP(S)_PROXY / NO_PROXY to fetch only; the previous node:http
  // implementation ignored them and login died with ENOTFOUND behind a proxy.
  test("goes through fetch so proxy environment variables apply", async () => {
    fetchSpy.mockResolvedValue(jsonResponse('{"status":true}'))

    const response = await httpClient.get(AUTH_URL, { headers: { jwtToken: "abc" } })

    const { url, init } = lastCall()
    expect(url).toBe(AUTH_URL)
    expect(init.method).toBe("GET")
    expect(init.headers).toMatchObject({ jwtToken: "abc", "accept-language": "zh-CN" })
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(response.statusCode).toBe(200)
    expect(response.data).toBe('{"status":true}')
    expect(response.headers["content-type"]).toBe("application/json")
    expect(httpClient.parseJson(response).status).toBe(true)
  })

  test("appends params as a query string", async () => {
    fetchSpy.mockResolvedValue(jsonResponse("{}"))

    await httpClient.get(AUTH_URL, { params: { tempToken: "t1", site: "CN" } })

    expect(lastCall().url).toBe(`${AUTH_URL}?tempToken=t1&site=CN`)
  })

  test("posts params as a JSON body", async () => {
    fetchSpy.mockResolvedValue(jsonResponse("{}"))

    await httpClient.post(AUTH_URL, { params: { tempToken: "t1" } })

    const { init } = lastCall()
    expect(init.method).toBe("POST")
    expect(init.body).toBe('{"tempToken":"t1"}')
  })

  test("honours a per-request timeout", async () => {
    fetchSpy.mockResolvedValue(jsonResponse("{}"))

    await httpClient.get(AUTH_URL, { timeout: 1234 })

    expect(timeoutSpy).toHaveBeenCalledWith(1234)
  })

  test("falls back to the default timeout when none is given", async () => {
    fetchSpy.mockResolvedValue(jsonResponse("{}"))

    await httpClient.get(AUTH_URL)

    expect(timeoutSpy).toHaveBeenCalledWith(20000)
  })

  test("does not follow redirects so a 302 stays visible", async () => {
    fetchSpy.mockResolvedValue(new Response("", { status: 302, headers: { location: "/login" } }))

    const response = await httpClient.get(AUTH_URL)

    expect(lastCall().init.redirect).toBe("manual")
    expect(response.statusCode).toBe(302)
    expect(response.headers["location"]).toBe("/login")
  })

  test("maps an aborted request to Request timeout and keeps the cause", async () => {
    const timeout = new Error("The operation timed out.")
    timeout.name = "TimeoutError"
    fetchSpy.mockRejectedValue(timeout)

    const error = await httpClient.get(AUTH_URL).then(
      () => null,
      (err: Error) => err,
    )

    expect(error?.message).toBe("Request timeout")
    expect(error?.cause).toBe(timeout)
  })

  test("maps a timeout while streaming the body to Request timeout", async () => {
    const timeout = new Error("The operation timed out.")
    timeout.name = "TimeoutError"
    fetchSpy.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(timeout)
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )

    const error = await httpClient.get(AUTH_URL).then(
      () => null,
      (err: Error) => err,
    )

    expect(error?.message).toBe("Request timeout")
    expect(error?.cause).toBe(timeout)
  })

  test("propagates DNS failures unchanged so they can be explained", async () => {
    const dns = new Error("getaddrinfo ENOTFOUND cn.devecostudio.huawei.com") as Error & { code?: string }
    dns.code = "ENOTFOUND"
    fetchSpy.mockRejectedValue(dns)

    await expect(httpClient.get(AUTH_URL)).rejects.toBe(dns)
  })

  test("parseJson rejects gateway HTML pages", () => {
    expect(() => httpClient.parseJson({ statusCode: 200, data: "<html>blocked</html>", headers: {} })).toThrow(/HTML/)
  })
})
