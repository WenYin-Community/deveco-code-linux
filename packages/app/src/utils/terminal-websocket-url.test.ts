import { describe, expect, test } from "bun:test"
import { terminalWebSocketURL } from "./terminal-websocket-url"

describe("terminalWebSocketURL", () => {
  test("uses ticket for WebSocket connections", () => {
    const url = terminalWebSocketURL({
      url: "http://127.0.0.1:49365",
      id: "pty_test",
      directory: "/tmp/project",
      cursor: 0,
      ticket: "test-ticket-uuid",
    })

    expect(url.protocol).toBe("ws:")
    expect(url.searchParams.get("ticket")).toBe("test-ticket-uuid")
    expect(url.searchParams.has("auth_token")).toBe(false)
  })

  test("builds WebSocket URL without ticket when none provided", () => {
    const url = terminalWebSocketURL({
      url: "https://app.example.test",
      id: "pty_test",
      directory: "/tmp/project",
      cursor: 10,
    })

    expect(url.protocol).toBe("wss:")
    expect(url.searchParams.has("ticket")).toBe(false)
    expect(url.searchParams.has("auth_token")).toBe(false)
  })
})
