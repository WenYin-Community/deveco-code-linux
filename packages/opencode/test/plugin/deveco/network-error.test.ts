import { describe, expect, test } from "bun:test"
import { NetworkError } from "@/plugin/deveco/errors"
import { describeNetworkError } from "@/plugin/deveco/network-error"

const AUTH_URL = "https://cn.devecostudio.huawei.com/authrouter/auth/api/jwToken/check"

function coded(message: string, code?: string, cause?: unknown) {
  const err = new Error(message) as Error & { code?: string }
  if (code) err.code = code
  if (cause) err.cause = cause
  return err
}

describe("describeNetworkError", () => {
  test("maps DNS resolution failure", () => {
    const message = describeNetworkError(coded("getaddrinfo ENOTFOUND cn.devecostudio.huawei.com", "ENOTFOUND"), AUTH_URL)
    expect(message).toContain("cn.devecostudio.huawei.com")
    expect(message).toContain("DNS")
    expect(message).toContain("HTTPS_PROXY")
  })

  test("maps the DNSException wrapper used by token refresh", () => {
    const message = describeNetworkError(
      new Error("refreshToken error: DNSException: getaddrinfo ENOTFOUND cn.devecostudio.huawei.com"),
      AUTH_URL,
    )
    expect(message).toContain("DNS failure")
  })

  test("maps connection refused", () => {
    const message = describeNetworkError(coded("Unable to connect. Is the computer able to access the url?", "ECONNREFUSED"), AUTH_URL)
    expect(message).toContain("Cannot reach cn.devecostudio.huawei.com")
  })

  test("maps timeouts, including the wrapped Request timeout", () => {
    expect(describeNetworkError(new Error("Request timeout"), AUTH_URL)).toContain("timed out")
    expect(describeNetworkError(coded("The operation timed out.", "ETIMEDOUT"), AUTH_URL)).toContain("timed out")
  })

  test("maps TLS interception", () => {
    const message = describeNetworkError(coded("unable to verify the first certificate", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"), AUTH_URL)
    expect(message).toContain("TLS")
    expect(message).toContain("NODE_EXTRA_CA_CERTS")
  })

  test("reads the cause chain", () => {
    const message = describeNetworkError(new Error("fetch failed", { cause: coded("connect ECONNREFUSED 127.0.0.1:7890", "ECONNREFUSED") }), AUTH_URL)
    expect(message).toContain("Cannot reach")
  })

  test("falls back to a generic host when no url is given", () => {
    expect(describeNetworkError(coded("getaddrinfo ENOTFOUND x", "ENOTFOUND"))).toContain("the DevEco auth server")
  })

  test("returns null for non-network errors", () => {
    expect(describeNetworkError(new Error("Invalid jwtToken format"), AUTH_URL)).toBeNull()
    expect(describeNetworkError(undefined, AUTH_URL)).toBeNull()
  })

  test("does not re-map an already described NetworkError", () => {
    const hint = describeNetworkError(coded("getaddrinfo ENOTFOUND x", "ENOTFOUND"), AUTH_URL)
    expect(hint).not.toBeNull()
    expect(describeNetworkError(new NetworkError(hint ?? ""), AUTH_URL)).toBeNull()
  })
})
