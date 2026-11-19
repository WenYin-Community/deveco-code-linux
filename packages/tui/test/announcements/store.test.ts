import { describe, expect, test } from "bun:test"
import { mkdtemp } from "fs/promises"
import os from "os"
import path from "path"
import { Flock } from "@opencode-ai/core/util/flock"
import { announcementKey } from "../../src/announcements/model"
import {
  announcementCachePath,
  commitAnnouncementResponse,
  loadAnnouncementCache,
  markAnnouncementRead,
} from "../../src/announcements/store"

const first = { title: "t", content: "c", publishTime: 1, read: false }
const second = { ...first, publishTime: 2 }

Flock.setGlobal({ state: os.tmpdir() })

describe("announcement store", () => {
  test("round trips the cache from disk", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ann-cache-"))
    const file = announcementCachePath(dir)
    const items = [first]
    await commitAnnouncementResponse(file, items)
    expect(await Bun.file(file).json()).toEqual(items)
    expect(await loadAnnouncementCache(file)).toEqual(items)
  })

  test("returns an empty cache when the file is corrupt", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ann-cache-"))
    const file = path.join(dir, "cache.json")
    await Bun.write(file, "{not json")
    expect(await loadAnnouncementCache(file)).toEqual([])
  })

  test("normalizes a structurally invalid cache to usable defaults", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ann-cache-"))
    const file = path.join(dir, "cache.json")
    await Bun.write(file, JSON.stringify({ announcements: [{ id: "old", ...first, read: true }] }))
    expect(await loadAnnouncementCache(file)).toEqual([])
    await Bun.write(file, "null")
    expect(await loadAnnouncementCache(file)).toEqual([])
    await Bun.write(file, JSON.stringify([null, { ...first, read: "true" }]))
    expect(await loadAnnouncementCache(file)).toEqual([first])
  })

  test("adds announcements from a late response without replacing cached content", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ann-cache-"))
    const file = path.join(dir, "cache.json")
    await commitAnnouncementResponse(file, [second])
    await commitAnnouncementResponse(file, [first, { ...second, content: "changed" }])
    expect(await loadAnnouncementCache(file)).toEqual([second, first])
  })

  test("preserves read flags and new announcements from concurrent writes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ann-read-"))
    Flock.setGlobal({ state: dir })
    const file = announcementCachePath(dir)
    const third = { ...first, publishTime: 3 }
    await commitAnnouncementResponse(file, [first, second])
    await Promise.all([
      markAnnouncementRead(file, announcementKey(first)),
      commitAnnouncementResponse(file, [third, first]),
      markAnnouncementRead(file, announcementKey(second)),
    ])
    expect(await loadAnnouncementCache(file)).toEqual([
      third,
      { ...second, read: true },
      { ...first, read: true },
    ])
  })

  test("does not create an announcement for an unknown read key", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ann-read-"))
    Flock.setGlobal({ state: dir })
    const file = announcementCachePath(dir)
    await commitAnnouncementResponse(file, [first])
    expect(await markAnnouncementRead(file, announcementKey(second))).toBe(false)
    expect(await loadAnnouncementCache(file)).toEqual([first])
  })
})

test("an empty incremental response leaves the existing cache intact", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ann-cache-"))
  const file = announcementCachePath(dir)
  const item = { ...first, read: true }
  await commitAnnouncementResponse(file, [item])
  await commitAnnouncementResponse(file, [])
  expect(await loadAnnouncementCache(file)).toEqual([item])
})
