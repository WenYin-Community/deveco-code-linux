/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createComponent, createRoot } from "solid-js"
import { createProviderRefresh } from "../../../src/component/provider-refresh"
import { SyncContext, useSync } from "../../../src/context/sync"

function mount(refresh: (signal?: AbortSignal) => Promise<void>) {
  let run: ReturnType<typeof createProviderRefresh> | undefined
  const dispose = createRoot((dispose) => {
    createComponent(SyncContext.Provider, {
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- This focused unit test only needs provider.refresh.
      value: { provider: { refresh } } as unknown as ReturnType<typeof useSync>,
      get children() {
        run = createProviderRefresh()
        return null
      },
    })
    return dispose
  })
  if (!run) throw new Error("Provider refresh harness failed to mount")
  return { run, dispose }
}

function pendingRefreshes(abortError: unknown = new DOMException("Aborted", "AbortError")) {
  const pending: Array<{ signal: AbortSignal; resolve: () => void }> = []
  return {
    pending,
    refresh: (signal?: AbortSignal) => {
      if (!signal) return Promise.reject(new Error("Missing abort signal"))
      return new Promise<void>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(abortError), { once: true })
        pending.push({ signal, resolve })
      })
    },
  }
}

test("superseded provider refresh resolves silently and only completes the replacement", async () => {
  const requests = pendingRefreshes(new Error("Wrapped abort failure"))
  const harness = mount(requests.refresh)
  let firstCompleted = false
  let secondCompleted = false

  const first = harness.run(() => {
    firstCompleted = true
  })
  const second = harness.run(() => {
    secondCompleted = true
  })

  expect(await first).toBeUndefined()
  expect(requests.pending[0]?.signal.aborted).toBe(true)
  expect(firstCompleted).toBe(false)

  requests.pending[1]?.resolve()
  expect(await second).toBeUndefined()
  expect(secondCompleted).toBe(true)
  harness.dispose()
})

test("provider refresh aborted by cleanup resolves silently", async () => {
  const requests = pendingRefreshes()
  const harness = mount(requests.refresh)
  let completed = false
  const refresh = harness.run(() => {
    completed = true
  })

  harness.dispose()

  expect(await refresh).toBeUndefined()
  expect(requests.pending[0]?.signal.aborted).toBe(true)
  expect(completed).toBe(false)
})

test("provider refresh errors still reject", async () => {
  const harness = mount(() => Promise.reject(new Error("Provider unavailable")))

  const result = await harness.run(() => {}).then(
    () => "resolved",
    (error) => (error instanceof Error ? error.message : String(error)),
  )
  expect(result).toBe("Provider unavailable")
  harness.dispose()
})
