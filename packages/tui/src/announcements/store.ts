import path from "path"
import { Flock } from "@opencode-ai/core/util/flock"
import { readJson, writeJsonAtomic } from "../util/persistence"
import { announcementKey, mergeAnnouncements, parseAnnouncement, sortAnnouncements, type Announcement } from "./model"

export function announcementCachePath(state: string) {
  return path.join(state, "announcements.json")
}

function lockKey(file: string) {
  return `tui-announcements:${file}`
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

async function readCache(file: string): Promise<Announcement[]> {
  const entries = await readJson<unknown>(file).catch((error: unknown) => {
    if (error instanceof SyntaxError || asRecord(error).code === "ENOENT") return
    throw error
  })
  if (!Array.isArray(entries)) return []
  const items = entries.flatMap((entry: unknown) => {
    const item = parseAnnouncement(entry)
    return item ? [{ ...item, read: asRecord(entry).read === true }] : []
  })
  return mergeAnnouncements([], items)
}

export async function loadAnnouncementCache(file: string) {
  return Flock.withLock(lockKey(file), () => readCache(file))
}

export async function commitAnnouncementResponse(file: string, items: Announcement[]) {
  return Flock.withLock(lockKey(file), async () => {
    const current = await readCache(file)
    const next = sortAnnouncements(mergeAnnouncements(current, items))
    await writeJsonAtomic(file, next)
    return next
  })
}

export async function markAnnouncementRead(file: string, key: string) {
  return Flock.withLock(lockKey(file), async () => {
    const cache = await readCache(file)
    const index = cache.findIndex((item) => announcementKey(item) === key)
    const item = cache[index]
    if (!item) return false
    if (!item.read) {
      cache[index] = { ...item, read: true }
      await writeJsonAtomic(file, cache)
    }
    return true
  })
}
