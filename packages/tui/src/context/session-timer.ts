/**
 * Tracks cumulative wall-clock time per session. Entering a session starts
 * a timer; leaving (switching, exiting) stops it and accumulates elapsed time.
 * Persists to a standalone JSON file with a periodic auto-save and exit hooks,
 * so time accrues even if the user never opens /usage or switches sessions.
 */
import { createSignal } from "solid-js"
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import path from "node:path"
import os from "node:os"

type TimerState = {
  currentSessionID: string | undefined
  enteredAt: number | undefined
}

const [state, setState] = createSignal<TimerState>({ currentSessionID: undefined, enteredAt: undefined })

const TIMER_FILE = path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local/state"), "deveco", "session-timer.json")

// In-memory accumulated durations (ms), keyed by sessionID.
const accumulated = new Map<string, number>()

let initialized = false

/** Load persisted durations from disk. Called once at module init or first use. */
function init() {
  if (initialized) return
  initialized = true
  if (!existsSync(TIMER_FILE)) return
  try {
    loadFile(TIMER_FILE)
  } catch {
    // Corrupt file — start fresh
  }
}

function loadFile(file: string) {
  const stored = JSON.parse(readFileSync(file, "utf-8")) as Record<string, number>
  for (const [id, ms] of Object.entries(stored)) accumulated.set(id, ms)
}

/**
 * Write current state to disk synchronously (includes active session elapsed).
 * Merges with whatever is on disk first (per-session max) so concurrent deveco
 * instances don't clobber each other's records.
 */
function save() {
  try {
    const data: Record<string, number> = {}
    // Start from what's on disk — another instance may have written newer values.
    if (existsSync(TIMER_FILE)) {
      try {
        const disk = JSON.parse(readFileSync(TIMER_FILE, "utf-8")) as Record<string, number>
        Object.assign(data, disk)
      } catch {
        // Corrupt file — overwrite
      }
    }
    // Merge in-memory values, keeping the larger per session.
    for (const [id, ms] of accumulated) {
      data[id] = Math.max(data[id] ?? 0, ms)
    }
    // Fold the active session's live elapsed into the snapshot.
    const s = state()
    if (s.currentSessionID && s.enteredAt) {
      const live = (accumulated.get(s.currentSessionID) ?? 0) + (Date.now() - s.enteredAt)
      data[s.currentSessionID] = Math.max(data[s.currentSessionID] ?? 0, live)
    }
    mkdirSync(path.dirname(TIMER_FILE), { recursive: true })
    writeFileSync(TIMER_FILE, JSON.stringify(data))
  } catch {
    // Best-effort persistence
  }
}

init()

// Auto-save every 30 seconds so long sessions accrue without user action.
const autoSave = setInterval(save, 30_000)
autoSave.unref()

// Save on SIGTERM then exit so the process stays killable (registering a
// listener suppresses the default termination). SIGINT is deliberately NOT
// handled here: the run command owns Ctrl+C (two-press confirm, editor
// passthrough) and its exit path triggers beforeExit, which saves below.
process.on("SIGTERM", () => {
  leaveSession()
  save()
  process.exit(0)
})

// beforeExit only fires on normal event-loop drain; save but never exit here
// (calling process.exit inside beforeExit would loop forever).
process.on("beforeExit", () => {
  save()
})

/** Call when the user navigates INTO a session. */
export function enterSession(sessionID: string) {
  leaveSession()
  setState({ currentSessionID: sessionID, enteredAt: Date.now() })
}

/** Call when the user navigates AWAY from a session. */
export function leaveSession() {
  const s = state()
  if (!s.currentSessionID || !s.enteredAt) return
  const elapsed = Date.now() - s.enteredAt
  accumulated.set(s.currentSessionID, (accumulated.get(s.currentSessionID) ?? 0) + elapsed)
  setState({ currentSessionID: undefined, enteredAt: undefined })
  save()
}

/**
 * Wall duration for a session: accumulated time from all visits plus
 * the current visit's elapsed time (if this is the active session).
 */
export function sessionWallDuration(sessionID: string): number {
  const acc = accumulated.get(sessionID) ?? 0
  const s = state()
  if (s.currentSessionID === sessionID && s.enteredAt) {
    return acc + (Date.now() - s.enteredAt)
  }
  return acc
}

/** The longest wall duration across all tracked sessions. */
export function longestSessionWallDuration(): number {
  let longest = 0
  for (const id of accumulated.keys()) {
    longest = Math.max(longest, sessionWallDuration(id))
  }
  // Also check the active session in case it's not yet in accumulated
  const s = state()
  if (s.currentSessionID && s.enteredAt) {
    longest = Math.max(longest, sessionWallDuration(s.currentSessionID))
  }
  return longest
}
