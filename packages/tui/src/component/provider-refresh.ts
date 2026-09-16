import { onCleanup } from "solid-js"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"

/** Refresh shared provider state, but never navigate from a closed dialog. */
export function createProviderRefresh() {
  const sdk = useSDK()
  const sync = useSync()
  let active = true
  onCleanup(() => {
    active = false
  })
  return async (complete: () => void) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      sdk.client.instance.dispose({}, { throwOnError: true }).then(() => sync.bootstrap({ fatal: false })),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Provider refresh timed out")), 10_000)
      }),
    ]).finally(() => clearTimeout(timer))
    if (active) complete()
  }
}
