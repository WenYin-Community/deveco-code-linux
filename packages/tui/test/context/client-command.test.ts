import { expect, test } from "bun:test"
import { createClientCommandReporter } from "../../src/context/sdk"

type RecordedRequest = {
  url: string
  method: string | undefined
  headers: Headers
  body: string | null
}

type ClientCommandFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function createFetch(recorded: RecordedRequest[], fail = false): ClientCommandFetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    recorded.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      method: init?.method,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    })
    if (fail) throw new Error("network down")
    return new Response("true", { status: 200 })
  }
}

function only(recorded: RecordedRequest[]): RecordedRequest {
  const request = recorded[0]
  if (!request) throw new Error("expected one request")
  return request
}

function parseBody(request: RecordedRequest): unknown {
  if (request.body === null) throw new Error("expected a JSON body")
  return JSON.parse(request.body)
}

// The reporter is fire-and-forget by design, so give its microtask queue a turn.
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

test("posts the command report to the instance analytics endpoint", async () => {
  const recorded: RecordedRequest[] = []
  const report = createClientCommandReporter({
    url: "http://127.0.0.1:4321",
    directory: "/work/my project",
    fetch: createFetch(recorded),
    headers: { Authorization: "Basic abc" },
  })

  report("sessions", "session-1")
  await settle()

  const request = only(recorded)
  expect(request.url).toBe("http://127.0.0.1:4321/analytics/command")
  expect(request.method).toBe("POST")
  expect(request.headers.get("content-type")).toBe("application/json")
  // Mirrors how the generated SDK tags POSTs: the routing middleware reads the directory there.
  expect(request.headers.get("x-deveco-directory")).toBe(encodeURIComponent("/work/my project"))
  expect(request.headers.get("authorization")).toBe("Basic abc")
  expect(parseBody(request)).toEqual({
    name: "sessions",
    sessionID: "session-1",
    directory: "/work/my project",
  })
})

test("omits the directory when the client has none", async () => {
  const recorded: RecordedRequest[] = []
  const report = createClientCommandReporter({ url: "http://127.0.0.1:4321", fetch: createFetch(recorded) })

  report("models")
  await settle()

  const request = only(recorded)
  expect(request.headers.get("x-deveco-directory")).toBeNull()
  expect(parseBody(request)).toEqual({ name: "models" })
})

test("empty names are not reported", async () => {
  const recorded: RecordedRequest[] = []
  const report = createClientCommandReporter({ url: "http://127.0.0.1:4321", fetch: createFetch(recorded) })

  report("")
  await settle()

  expect(recorded).toHaveLength(0)
})

test("reporter failures stay inside the reporter", async () => {
  const recorded: RecordedRequest[] = []
  const report = createClientCommandReporter({ url: "http://127.0.0.1:4321", fetch: createFetch(recorded, true) })

  // A rejected fetch must not become an unhandled rejection or reach the caller.
  expect(() => report("sessions")).not.toThrow()
  await settle()

  expect(recorded).toHaveLength(1)
})
