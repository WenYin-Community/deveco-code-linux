import { describe, expect, test } from "bun:test"
import { mergeAnnouncements, normalizeResponse, sortAnnouncements, type Announcement } from "../../src/announcements/model"

const item = (over: Partial<Announcement> = {}): Announcement => ({
  title: "t",
  content: "c",
  publishTime: 100,
  read: false,
  ...over,
})

describe("announcement model", () => {
  test("normalizes a single object body and initializes it as unread", () => {
    expect(
      normalizeResponse({
        code: "200",
        body: { title: "新功能上线", content: "欢迎体验", publishTime: 1763059200000, read: true },
      }),
    ).toEqual([
      {
        title: "新功能上线",
        content: "欢迎体验",
        publishTime: 1763059200000,
        read: false,
      },
    ])
  })

  test("accepts a numeric success code", () => {
    const result = normalizeResponse({
      code: 200,
      body: { title: "t", content: "c", publishTime: 1 },
    })
    expect(result).toEqual([item({ publishTime: 1 })])
  })

  test("normalizes an array as a batch of announcements", () => {
    const entry = { title: "t", content: "c", publishTime: 1 }
    expect(normalizeResponse({ code: "200", body: [entry] })).toEqual(normalizeResponse({ code: "200", body: entry }))
    expect(normalizeResponse({ code: "200", body: [] })).toEqual([])
  })

  test("rejects business failures and malformed bodies", () => {
    expect(normalizeResponse({ code: "500", body: {} })).toBeUndefined()
    expect(normalizeResponse({ code: "200" })).toBeUndefined()
    expect(normalizeResponse({ code: "200", body: { title: "t" } })).toBeUndefined()
    expect(normalizeResponse({ code: "200", body: [{ content: "c", publishTime: 1 }] })).toBeUndefined()
  })

  test("deduplicates by title and publish time against the cache and within a batch", () => {
    const cached = item({ read: true })
    const sameTitle = item({ publishTime: 200 })
    const sameTime = item({ title: "different title" })
    const batch = normalizeResponse({
      code: 200,
      body: [item({ content: "changed" }), sameTitle, { ...sameTitle, content: "duplicate" }, sameTime],
    })!
    expect(mergeAnnouncements([cached], batch)).toEqual([cached, sameTitle, sameTime])
  })

  test("sorts by publish time descending then title", () => {
    const sorted = sortAnnouncements([
      item({ title: "b", publishTime: 2 }),
      item({ title: "a", publishTime: 2 }),
      item({ title: "c", publishTime: 3 }),
    ])
    expect(sorted.map((x) => x.title)).toEqual(["c", "a", "b"])
  })
})

test("rejects timestamps outside the shared integer contract", () => {
  const entry = { title: "t", content: "c", publishTime: 1 }
  for (const publishTime of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(normalizeResponse({ code: 200, body: { ...entry, publishTime } })).toBeUndefined()
  }
})
