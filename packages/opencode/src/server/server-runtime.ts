import { Effect } from "effect"

// ─── Server-tree re-entry handle ────────────────────────────
// `Server.listen` builds its own Effect tree (fresh memoMap in
// `startListener`) with its own Permission/Session/InstanceStore
// instances, parallel to the AppRuntime tree. Module-level code
// outside that tree (e.g. the HDC guard IPC handler) cannot reach
// those services through AppRuntime — AppRuntime hosts a different
// tree, so a permission ask created there is invisible to the HTTP
// routes the TUI uses. `Server.listen` registers a re-entry handle
// here so such code can run effects inside the server tree, where
// HTTP requests — and their replies — are actually served.

export interface Shape {
  readonly runPromise: <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>
}

let current: Shape | undefined

export function register(handle: Shape): void {
  current = handle
}

export function unregister(handle: Shape): void {
  if (current === handle) current = undefined
}

export function runPromise<A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> {
  if (!current) {
    return Promise.reject(new Error("no server runtime is registered in this process"))
  }
  return current.runPromise(effect)
}

export * as ServerRuntime from "./server-runtime"
