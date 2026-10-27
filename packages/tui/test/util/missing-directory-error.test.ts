import { describe, expect, test } from "bun:test"
import { missingDirectoryError } from "../../src/util/error"

/** Wraps a response body the way the SDK reports a failed throwOnError request. */
function thrown(body: unknown) {
  return new Error("request failed", { cause: { body, status: 409 } })
}

describe("util.error.missingDirectoryError", () => {
  test("reads the typed api body, which names the session", () => {
    const body = {
      _tag: "SessionDirectoryMissingError",
      sessionID: "ses_123",
      directory: "/tmp/gone",
      message: "Session directory does not exist: /tmp/gone",
    }
    expect(missingDirectoryError(thrown(body))).toEqual({ sessionID: "ses_123", directory: "/tmp/gone" })
  })

  test("reads the instance api body, which names the directory only", () => {
    const body = {
      _tag: "DirectoryMissingError",
      directory: "/tmp/gone",
      message: "Directory does not exist: /tmp/gone",
    }
    expect(missingDirectoryError(thrown(body))).toEqual({ sessionID: undefined, directory: "/tmp/gone" })
    // A transport that kept the body as raw text is parsed once.
    expect(missingDirectoryError(thrown(JSON.stringify(body)))).toEqual({
      sessionID: undefined,
      directory: "/tmp/gone",
    })
  })

  test("ignores failures that are not a missing directory", () => {
    const unrelated = [
      undefined,
      null,
      "boom",
      new Error("boom"),
      { _tag: "DirectoryMissingError", directory: "/tmp/gone" },
      new Error("boom", { cause: { body: { _tag: "ConflictError", message: "conflict" }, status: 409 } }),
      new Error("boom", { cause: { body: "plain text", status: 409 } }),
      thrown({ _tag: "SessionNotFoundError", sessionID: "ses_123", message: "nope" }),
    ]
    for (const input of unrelated) expect(missingDirectoryError(input)).toBeUndefined()
  })
})
