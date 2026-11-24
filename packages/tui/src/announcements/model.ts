export interface Announcement {
  title: string
  content: string
  publishTime: number
  read: boolean
}

export function announcementKey(item: Pick<Announcement, "title" | "publishTime">) {
  return JSON.stringify([item.title, item.publishTime])
}

export function normalizeResponse(payload: unknown): Announcement[] | undefined {
  if (!payload || typeof payload !== "object") return
  const record = payload as Record<string, unknown>
  if (record.code !== "200" && record.code !== 200) return
  const entries = Array.isArray(record.body) ? record.body : [record.body]
  const items = entries.map(parseAnnouncement).filter((item) => item !== undefined)
  if (items.length !== entries.length) return
  return items.map((item) => ({ ...item, read: false }))
}

export function mergeAnnouncements(current: Announcement[], incoming: Announcement[]) {
  const known = new Set(current.map(announcementKey))
  const fresh = incoming.filter((item) => {
    const key = announcementKey(item)
    if (known.has(key)) return false
    known.add(key)
    return true
  })
  return [...current, ...fresh]
}

export function sortAnnouncements(items: Announcement[]) {
  return [...items].sort((a, b) => b.publishTime - a.publishTime || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0))
}

export function parseAnnouncement(value: unknown) {
  if (!value || typeof value !== "object") return
  const record = value as Record<string, unknown>
  if (typeof record.title !== "string" || typeof record.content !== "string") return
  if (typeof record.publishTime !== "number" || !Number.isSafeInteger(record.publishTime) || record.publishTime < 0)
    return
  return {
    title: record.title,
    content: record.content,
    publishTime: record.publishTime,
  }
}
