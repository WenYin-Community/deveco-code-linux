import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { Flag } from "@opencode-ai/core/flag/flag"
import { createSimpleContext } from "./helper"
import { batch, onCleanup, onMount } from "solid-js"

export type EventSource = {
  subscribe: (handler: (event: GlobalEvent) => void) => Promise<() => void>
}

export type ClientCommandReporter = (name: string, sessionID?: string) => void

// Narrower than the global fetch type (which also carries Bun helpers) so callers and tests can
// pass any plain fetch implementation.
type ClientCommandFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type ClientCommandReporterOptions = {
  url: string
  directory?: string
  fetch?: ClientCommandFetch
  headers?: RequestInit["headers"]
}

// Reports a slash command this client executed itself. Palette commands run inside the TUI and
// never reach SessionPrompt.command, so the server cannot count them through its command hook.
// The call is fire-and-forget and swallows every failure: analytics must never disturb the TUI.
export function createClientCommandReporter(options: ClientCommandReporterOptions): ClientCommandReporter {
  return (name, sessionID) => {
    if (!name) return
    void sendClientCommand(options, name, sessionID)
  }
}

async function sendClientCommand(
  options: ClientCommandReporterOptions,
  name: string,
  sessionID: string | undefined,
): Promise<void> {
  try {
    await (options.fetch ?? fetch)(new URL("/analytics/command", options.url), {
      method: "POST",
      headers: clientCommandHeaders(options),
      body: JSON.stringify({ name, sessionID, directory: options.directory }),
    })
  } catch {
    // Reporting is best-effort.
  }
}

function clientCommandHeaders(options: ClientCommandReporterOptions): Headers {
  const headers = new Headers(options.headers)
  headers.set("Content-Type", "application/json")
  // Mirrors the generated SDK's POST shape: it tags the request with the directory header
  // (the query parameter rewriting only applies to GET/HEAD), which is what the instance
  // routing middleware reads to pick the project.
  if (options.directory) headers.set("x-deveco-directory", encodeURIComponent(options.directory))
  return headers
}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: {
    url: string
    directory?: string
    fetch?: typeof fetch
    headers?: RequestInit["headers"]
    events?: EventSource
  }) => {
    const abort = new AbortController()
    let sse: AbortController | undefined

    function createSDK() {
      return createOpencodeClient({
        baseUrl: props.url,
        signal: abort.signal,
        directory: props.directory,
        fetch: props.fetch,
        headers: props.headers,
      })
    }

    let sdk = createSDK()

    const handlers = new Set<(event: GlobalEvent) => void>()
    const emitter = {
      emit(_type: "event", event: GlobalEvent) {
        for (const handler of handlers) handler(event)
      },
      on(_type: "event", handler: (event: GlobalEvent) => void) {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
    }

    let queue: GlobalEvent[] = []
    let timer: Timer | undefined
    let last = 0
    const retryDelay = 1000
    const maxRetryDelay = 30000

    const flush = () => {
      if (queue.length === 0) return
      const events = queue
      queue = []
      timer = undefined
      last = Date.now()
      // Batch all event emissions so all store updates result in a single render
      batch(() => {
        for (const event of events) {
          emitter.emit("event", event)
        }
      })
    }

    const handleEvent = (event: GlobalEvent) => {
      queue.push(event)
      const elapsed = Date.now() - last

      if (timer) return
      // If we just flushed recently (within 16ms), batch this with future events
      // Otherwise, process immediately to avoid latency
      if (elapsed < 16) {
        timer = setTimeout(flush, 16)
        return
      }
      flush()
    }

    function startSSE() {
      sse?.abort()
      const ctrl = new AbortController()
      sse = ctrl
      ;(async () => {
        let attempt = 0
        while (true) {
          if (abort.signal.aborted || ctrl.signal.aborted) break

          const events = await sdk.global.event({
            signal: ctrl.signal,
            sseMaxRetryAttempts: 0,
          })

          if (Flag.DEVECO_EXPERIMENTAL_WORKSPACES) {
            // Start syncing workspaces, it's important to do this after
            // we've started listening to events
            await sdk.sync.start().catch(() => {})
          }

          for await (const event of events.stream) {
            if (ctrl.signal.aborted) break
            handleEvent(event)
          }

          if (timer) clearTimeout(timer)
          if (queue.length > 0) flush()
          attempt += 1
          if (abort.signal.aborted || ctrl.signal.aborted) break

          // Exponential backoff
          const backoff = Math.min(retryDelay * 2 ** (attempt - 1), maxRetryDelay)
          await new Promise((resolve) => setTimeout(resolve, backoff))
        }
      })().catch(() => {})
    }

    onMount(async () => {
      if (props.events) {
        const unsub = await props.events.subscribe(handleEvent)
        onCleanup(unsub)

        if (Flag.DEVECO_EXPERIMENTAL_WORKSPACES) {
          // Start syncing workspaces, it's important to do this after
          // we've started listening to events
          await sdk.sync.start().catch(() => {})
        }
      } else {
        startSSE()
      }
    })

    onCleanup(() => {
      abort.abort()
      sse?.abort()
      if (timer) clearTimeout(timer)
      handlers.clear()
    })

    return {
      get client() {
        return sdk
      },
      directory: props.directory,
      event: emitter,
      fetch: props.fetch ?? fetch,
      reportClientCommand: createClientCommandReporter(props),
      url: props.url,
    }
  },
})
