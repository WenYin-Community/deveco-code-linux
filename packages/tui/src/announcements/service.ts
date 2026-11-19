import { fetchAnnouncements } from "./client"
import { announcementKey, sortAnnouncements, type Announcement } from "./model"
import { announcementCachePath, commitAnnouncementResponse, loadAnnouncementCache, markAnnouncementRead } from "./store"

export interface AnnouncementState {
  items: Announcement[]
  promptVersion: number
}

const backoff = [30_000, 60_000, 120_000, 300_000]

export function createAnnouncementService(input: {
  stateDir: string
  onChange: (state: AnnouncementState) => void
  fetcher?: (signal: AbortSignal) => Promise<Announcement[]>
}) {
  const cacheFile = announcementCachePath(input.stateDir)
  const fetcher = input.fetcher ?? fetchAnnouncements
  const prompted = new Set<string>()
  let state: AnnouncementState = { items: [], promptVersion: 0 }
  let inflight: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined
  let failures = 0
  let disposed = false

  function publish(next: AnnouncementState) {
    if (disposed) return
    state = next
    input.onChange(next)
  }

  function promptUnread(items: Announcement[]) {
    const fresh = items.filter((item) => {
      const key = announcementKey(item)
      if (item.read || prompted.has(key)) return false
      prompted.add(key)
      return true
    })
    if (fresh.length === 0) return
    publish({ ...state, promptVersion: state.promptVersion + 1 })
  }

  function schedule() {
    if (disposed) return
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    const delay = failures > 0 ? backoff[Math.min(failures - 1, backoff.length - 1)]! : 30 * 60_000
    timer = setTimeout(
      () => {
        timer = undefined
        void refresh()
      },
      delay + Math.random() * 1000,
    )
  }

  async function start() {
    const cache = await loadAnnouncementCache(cacheFile)
    if (disposed) return
    publish({
      items: sortAnnouncements(cache),
      promptVersion: 0,
    })
    promptUnread(state.items)
  }

  function refresh() {
    if (disposed) return Promise.resolve()
    if (inflight) return inflight
    const active = new AbortController()
    controller = active
    const timeout = setTimeout(() => active.abort(), 10_000)
    inflight = Promise.resolve()
      .then(async () => {
        if (disposed) return
        const items = await fetcher(active.signal)
        if (disposed) return
        const persisted = await commitAnnouncementResponse(cacheFile, items)
        if (disposed) return
        failures = 0
        // A read can reach the UI while a refresh is resuming after releasing the file lock.
        const readKeys = new Set(state.items.filter((item) => item.read).map(announcementKey))
        const merged = persisted.map((item) =>
          item.read || !readKeys.has(announcementKey(item)) ? item : { ...item, read: true },
        )
        publish({
          ...state,
          items: merged,
        })
        promptUnread(merged)
      })
      .catch(() => {
        if (!disposed) failures++
      })
      .finally(() => {
        clearTimeout(timeout)
        controller = undefined
        inflight = undefined
        schedule()
      })
    return inflight
  }

  async function markRead(key: string) {
    if (disposed || state.items.find((item) => announcementKey(item) === key)?.read) return
    if (!(await markAnnouncementRead(cacheFile, key)) || disposed) return
    publish({ ...state, items: state.items.map((item) => (announcementKey(item) === key ? { ...item, read: true } : item)) })
  }

  function ackPrompt(version: number) {
    if (disposed || state.promptVersion !== version) return
    publish({ ...state, promptVersion: 0 })
  }

  function stop() {
    disposed = true
    if (timer) clearTimeout(timer)
    controller?.abort()
  }

  return {
    start,
    refresh,
    markRead,
    ackPrompt,
    stop,
    get state() {
      return state
    },
  }
}
