import { onCleanup } from "solid-js"
import { useSync } from "../context/sync"

type ProviderRefreshState = {
  active: boolean
  controller?: AbortController
}

/** Refresh shared provider state, but never navigate from a closed dialog. */
export function createProviderRefresh() {
  const state: ProviderRefreshState = { active: true }
  const refresh = useSync().provider.refresh
  onCleanup(() => stopProviderRefresh(state))
  return (complete: () => void) => runProviderRefresh(state, refresh, complete)
}

function stopProviderRefresh(state: ProviderRefreshState) {
  state.active = false
  state.controller?.abort()
}

async function runProviderRefresh(
  state: ProviderRefreshState,
  refresh: (signal?: AbortSignal) => Promise<void>,
  complete: () => void,
) {
  state.controller?.abort()
  const request = new AbortController()
  state.controller = request
  try {
    await refreshWithTimeout(refresh, request)
  } catch (error) {
    if (!state.active || state.controller !== request) return
    throw error
  } finally {
    if (state.controller === request) state.controller = undefined
  }
  if (state.active && !request.signal.aborted) complete()
}

function refreshWithTimeout(refresh: (signal?: AbortSignal) => Promise<void>, request: AbortController) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    refresh(request.signal),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        request.abort()
        reject(new Error("Provider refresh timed out"))
      }, 10_000)
    }),
  ]).finally(() => clearTimeout(timer))
}
