import { beforeEach, describe, expect, jest, test } from "bun:test"
import { mkdtemp } from "fs/promises"
import os from "os"
import path from "path"
import { Flock } from "@opencode-ai/core/util/flock"
import { announcementKey, type Announcement } from "../../src/announcements/model"
import { createAnnouncementService } from "../../src/announcements/service"
import { announcementCachePath, loadAnnouncementCache } from "../../src/announcements/store"

let scenario = "single"
let requests = 0
const firstAnnouncement = { title: "one", content: "first", publishTime: 1, read: false }

beforeEach(() => {
  scenario = "single"
  requests = 0
})

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ann-service-"))
  Flock.setGlobal({ state: dir })
  const cacheFile = announcementCachePath(dir)
  const changes: number[] = []
  const service = createAnnouncementService({
    stateDir: dir,
    onChange: (state) => changes.push(state.promptVersion),
    fetcher: async () => {
      requests++
      if (scenario === "failure") throw new Error("Announcement request failed")
      if (scenario === "update") return [{ ...firstAnnouncement, content: "new body" }]
      if (scenario === "batch") return [{ ...firstAnnouncement, content: "second", publishTime: 2 }]
      return [firstAnnouncement]
    },
  })
  await service.start()
  return { service, cacheFile, changes }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function controllableFetcher() {
  const started = deferred<void>()
  const result = deferred<Announcement[]>()
  return {
    started: started.promise,
    resolve: result.resolve,
    fetcher: async () => {
      started.resolve()
      return result.promise
    },
  }
}

describe("announcement service", () => {
  test("loads cached announcements and prompts once for cached unread", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ann-service-"))
    Flock.setGlobal({ state: dir })
    const cacheFile = announcementCachePath(dir)
    await Bun.write(
      cacheFile,
      JSON.stringify([{ title: "cached", content: "body", publishTime: 1, read: false }]),
    )
    const service = createAnnouncementService({ stateDir: dir, onChange: () => {} })
    await service.start()
    expect(service.state.items[0]?.title).toBe("cached")
    expect(service.state.promptVersion).toBe(1)
    service.stop()
  })

  test("ignores a repeated title and time and prompts when the title is reused at a new time", async () => {
    const { service, cacheFile } = await setup()
    await service.refresh()
    const original = service.state.items[0]!
    await service.markRead(announcementKey(original))
    service.ackPrompt(service.state.promptVersion)

    scenario = "update"
    await service.refresh()
    expect(service.state.items).toEqual([{ ...original, read: true }])
    expect(service.state.promptVersion).toBe(0)

    scenario = "batch"
    await service.refresh()
    expect(service.state.items.map((item) => item.publishTime)).toEqual([2, 1])
    expect(service.state.items[1]).toEqual({ ...original, read: true })
    expect(service.state.items[0]?.read).toBe(false)
    expect(service.state.promptVersion).toBeGreaterThan(0)
    const saved = await loadAnnouncementCache(cacheFile)
    expect(saved).toEqual(service.state.items)
    service.stop()
  })

  test("coalesces concurrent refreshes into one request", async () => {
    const { service } = await setup()
    await Promise.all([service.refresh(), service.refresh(), service.refresh()])
    expect(requests).toBe(1)
    service.stop()
  })

  test("marks an announcement as read and acknowledges the prompt", async () => {
    const { service, cacheFile } = await setup()
    await service.refresh()
    const reading = service.state.items[0]!
    await service.markRead(announcementKey(reading))
    expect(service.state.items[0]?.read).toBe(true)
    expect((await loadAnnouncementCache(cacheFile))[0]?.read).toBe(true)
    service.ackPrompt(service.state.promptVersion)
    expect(service.state.promptVersion).toBe(0)
    service.stop()
  })

  test("keeps the last successful cache when the request fails", async () => {
    const { service, cacheFile, changes } = await setup()
    await service.refresh()
    const cached = await loadAnnouncementCache(cacheFile)
    const previousChanges = changes.length
    scenario = "failure"
    await service.refresh()
    expect(changes).toHaveLength(previousChanges)
    expect(service.state.items).toEqual(cached)
    expect(await loadAnnouncementCache(cacheFile)).toEqual(cached)
    service.stop()
  })

  test("does not prompt again for an announcement already shown in this session", async () => {
    const { service } = await setup()
    await service.refresh()
    const first = service.state.promptVersion
    expect(first).toBeGreaterThan(0)
    service.ackPrompt(first)
    await service.refresh()
    expect(service.state.promptVersion).toBe(0)
    service.stop()
  })

  test("keeps the first persisted body for the same title and time across overlapping requests", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ann-service-"))
    Flock.setGlobal({ state: dir })
    const cacheFile = announcementCachePath(dir)
    const firstFetch = controllableFetcher()
    const secondFetch = controllableFetcher()
    const first = createAnnouncementService({ stateDir: dir, onChange: () => {}, fetcher: firstFetch.fetcher })
    const second = createAnnouncementService({ stateDir: dir, onChange: () => {}, fetcher: secondFetch.fetcher })
    await Promise.all([first.start(), second.start()])
    const firstRefresh = first.refresh()
    await firstFetch.started
    const secondRefresh = second.refresh()
    await secondFetch.started
    secondFetch.resolve([{ ...firstAnnouncement, content: "second" }])
    await secondRefresh
    firstFetch.resolve([firstAnnouncement])
    await firstRefresh
    expect(await loadAnnouncementCache(cacheFile)).toEqual([{ ...firstAnnouncement, content: "second" }])
    expect(first.state.items[0]?.content).toBe("second")
    expect(second.state.items[0]?.content).toBe("second")
    first.stop()
    second.stop()
  })

  test("merges incremental updates from separate service instances started on an empty cache", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ann-service-"))
    Flock.setGlobal({ state: dir })
    const cacheFile = announcementCachePath(dir)
    const first = createAnnouncementService({
      stateDir: dir,
      onChange: () => {},
      fetcher: async () => [{ title: "a", content: "body", publishTime: 1, read: false }],
    })
    const second = createAnnouncementService({
      stateDir: dir,
      onChange: () => {},
      fetcher: async () => [{ title: "b", content: "body", publishTime: 2, read: false }],
    })
    await Promise.all([first.start(), second.start()])
    await first.refresh()
    await second.refresh()
    expect((await loadAnnouncementCache(cacheFile)).map((item) => item.title).sort()).toEqual(["a", "b"])
    first.stop()
    second.stop()

    const restarted = createAnnouncementService({ stateDir: dir, onChange: () => {} })
    await restarted.start()
    expect(restarted.state.items.map((item) => item.title).sort()).toEqual(["a", "b"])
    restarted.stop()
  })

  test("keeps both announcements when overlapping responses arrive out of order", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ann-service-"))
    Flock.setGlobal({ state: dir })
    const cacheFile = announcementCachePath(dir)
    const firstFetch = controllableFetcher()
    const secondFetch = controllableFetcher()
    const first = createAnnouncementService({ stateDir: dir, onChange: () => {}, fetcher: firstFetch.fetcher })
    const second = createAnnouncementService({ stateDir: dir, onChange: () => {}, fetcher: secondFetch.fetcher })
    await Promise.all([first.start(), second.start()])
    const firstRefresh = first.refresh()
    await firstFetch.started
    const secondRefresh = second.refresh()
    await secondFetch.started
    secondFetch.resolve([{ title: "b", content: "body", publishTime: 2, read: false }])
    await secondRefresh
    firstFetch.resolve([{ title: "a", content: "body", publishTime: 1, read: false }])
    await firstRefresh
    expect((await loadAnnouncementCache(cacheFile)).map((item) => item.title).sort()).toEqual(["a", "b"])
    first.stop()
    second.stop()
  })

  test("continues cloud refresh when the cache has valid JSON but an invalid shape", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ann-service-"))
    Flock.setGlobal({ state: dir })
    const cacheFile = announcementCachePath(dir)
    await Bun.write(cacheFile, "{}")
    let calls = 0
    const service = createAnnouncementService({
      stateDir: dir,
      onChange: () => {},
      fetcher: async () => {
        calls++
        return [{ title: "fetched", content: "body", publishTime: 1, read: false }]
      },
    })
    await service.start()
    await service.refresh()
    expect(calls).toBe(1)
    expect(service.state.items[0]?.title).toBe("fetched")
    service.stop()
  })

  test("does not fetch or publish after stop", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ann-service-"))
    Flock.setGlobal({ state: dir })
    let calls = 0
    const changes: number[] = []
    const service = createAnnouncementService({
      stateDir: dir,
      onChange: (state) => changes.push(state.promptVersion),
      fetcher: async () => {
        calls++
        return [firstAnnouncement]
      },
    })
    service.stop()
    await service.refresh()
    await service.markRead(announcementKey(firstAnnouncement))
    expect(calls).toBe(0)
    expect(changes).toEqual([])
  })

  test("does not persist a response that resolves after stop", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ann-service-"))
    Flock.setGlobal({ state: dir })
    const cacheFile = announcementCachePath(dir)
    const fetch = controllableFetcher()
    const service = createAnnouncementService({ stateDir: dir, onChange: () => {}, fetcher: fetch.fetcher })
    await service.start()
    const refresh = service.refresh()
    await fetch.started
    service.stop()
    fetch.resolve([firstAnnouncement])
    await refresh
    expect(await loadAnnouncementCache(cacheFile)).toEqual([])
  })

  test("ignores cache loading and follow-up refresh completed after stop", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ann-service-"))
    Flock.setGlobal({ state: dir })
    const cacheFile = announcementCachePath(dir)
    await Bun.write(cacheFile, JSON.stringify([firstAnnouncement]))
    let calls = 0
    const changes: number[] = []
    const service = createAnnouncementService({
      stateDir: dir,
      onChange: (state) => changes.push(state.promptVersion),
      fetcher: async () => {
        calls++
        return []
      },
    })
    let started!: Promise<void>
    await Flock.withLock(`tui-announcements:${cacheFile}`, async () => {
      started = service.start()
      await Bun.sleep(20)
      service.stop()
    })
    await started
    await service.refresh()
    expect(changes).toEqual([])
    expect(calls).toBe(0)
  })

  test("does not publish a markRead result that completes after stop", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ann-service-"))
    Flock.setGlobal({ state: dir })
    const cacheFile = announcementCachePath(dir)
    const changes: number[] = []
    const service = createAnnouncementService({
      stateDir: dir,
      onChange: (state) => changes.push(state.promptVersion),
      fetcher: async () => [firstAnnouncement],
    })
    await service.start()
    await service.refresh()
    const changesAfterStart = changes.length
    let pending!: Promise<void>
    await Flock.withLock(`tui-announcements:${cacheFile}`, async () => {
      pending = service.markRead(announcementKey(firstAnnouncement))
      service.stop()
    })
    await pending
    expect(changes).toHaveLength(changesAfterStart)
    expect(await loadAnnouncementCache(cacheFile)).toEqual([{ ...firstAnnouncement, read: true }])
  })

  test("schedules a shorter retry after a query fails", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ann-service-"))
    Flock.setGlobal({ state: dir })
    let calls = 0
    const delays: number[] = []
    const originalSetTimeout = globalThis.setTimeout
    const timeoutSpy = jest.spyOn(globalThis, "setTimeout")
    timeoutSpy.mockImplementation(((
      handler: (...args: unknown[]) => void,
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (typeof timeout === "number" && timeout >= 30_000) delays.push(timeout)
      return Reflect.apply(originalSetTimeout, globalThis, [handler, timeout, ...args]) as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout)
    try {
      const service = createAnnouncementService({
        stateDir: dir,
        onChange: () => {},
        fetcher: async () => {
          calls++
          if (calls === 1) return []
          throw new Error("boom")
        },
      })
      await service.refresh()
      expect(delays).toHaveLength(1)
      expect(delays[0]!).toBeGreaterThanOrEqual(30 * 60_000)
      await service.refresh()
      expect(delays).toHaveLength(2)
      expect(delays[1]!).toBeGreaterThanOrEqual(30_000)
      expect(delays[1]!).toBeLessThan(31_000)
      service.stop()
    } finally {
      timeoutSpy.mockRestore()
    }
  })
})
