import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { fetchAnnouncements } from "../../src/announcements/client"

const first = { title: "one", content: "first", publishTime: 2 }
const second = { title: "two", content: "second", publishTime: 1 }
let request: Mock<typeof fetch>

beforeEach(() => {
  request = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected announcement request"))
})

afterEach(() => {
  request.mockRestore()
})

describe("announcement client", () => {
  test("uses the official endpoint with the client name and installed version", async () => {
    request.mockResolvedValueOnce(Response.json({ code: "200", body: first }))
    const signal = new AbortController().signal
    const result = await fetchAnnouncements(signal)
    expect(result).toEqual([{ ...first, read: false }])
    expect(request).toHaveBeenCalledTimes(1)
    const [target, init] = request.mock.calls[0]!
    const url = new URL(String(target))
    expect(url.origin).toBe("https://cn.devecostudio.huawei.com")
    expect(url.pathname).toBe("/sse/codeGenie/announcement")
    expect(url.searchParams.get("clientName")).toBe("deveco-code")
    expect(url.searchParams.get("clientVersion")).toBe(InstallationVersion)
    expect(init).toEqual({ method: "GET", signal })
  })

  test("normalizes a batch and accepts an empty batch", async () => {
    request.mockResolvedValueOnce(Response.json({ code: 200, body: [first, second] }))
    request.mockResolvedValueOnce(Response.json({ code: 200, body: [] }))
    const batch = await fetchAnnouncements(new AbortController().signal)
    expect(batch).toEqual([{ ...first, read: false }, { ...second, read: false }])
    expect(await fetchAnnouncements(new AbortController().signal)).toEqual([])
  })

  test("rejects http errors, business failures and invalid json", async () => {
    request.mockResolvedValueOnce(new Response(null, { status: 500 }))
    request.mockResolvedValueOnce(Response.json({ code: 500, body: {} }))
    request.mockResolvedValueOnce(new Response("<html>not json</html>"))
    await expect(fetchAnnouncements(new AbortController().signal)).rejects.toThrow("500")
    await expect(fetchAnnouncements(new AbortController().signal)).rejects.toThrow("Invalid announcement response")
    await expect(fetchAnnouncements(new AbortController().signal)).rejects.toBeInstanceOf(SyntaxError)
  })
})
