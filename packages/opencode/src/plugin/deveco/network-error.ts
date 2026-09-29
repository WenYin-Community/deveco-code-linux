import { NetworkError } from "./errors"

type CodedError = {
  name?: unknown
  message?: unknown
  code?: unknown
  cause?: unknown
}

const MAX_CAUSE_DEPTH = 5

const PROXY_HINT = " If your network requires a proxy, set HTTPS_PROXY (and NO_PROXY for internal hosts)."

function errorText(err: unknown): string {
  const parts: string[] = []
  let current: unknown = err
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current; depth++) {
    const candidate = current as CodedError
    if (typeof candidate.name === "string") parts.push(candidate.name)
    if (typeof candidate.message === "string") parts.push(candidate.message)
    if (candidate.code !== undefined) parts.push(String(candidate.code))
    current = candidate.cause
  }
  return parts.join(" | ")
}

function hostOf(url?: string): string {
  if (!url) return "the DevEco auth server"
  try {
    return new URL(url).host
  } catch {
    return "the DevEco auth server"
  }
}

const RULES: Array<{ pattern: RegExp; message: (host: string) => string }> = [
  {
    pattern: /proxy/i,
    message: (host) => `Cannot reach ${host} through the configured proxy.${PROXY_HINT}`,
  },
  {
    pattern: /ENOTFOUND|EAI_AGAIN|getaddrinfo|DNSException|\bDNS\b/i,
    message: (host) => `Cannot resolve the address of ${host} (DNS failure). Check your network connection, DNS settings, and VPN.${PROXY_HINT}`,
  },
  {
    pattern: /ECONNREFUSED|ConnectionRefused|Unable to connect|ENETUNREACH|EHOSTUNREACH|ENETDOWN|NetworkUnreachable/i,
    message: (host) =>
      `Cannot reach ${host} (connection refused or network unreachable). Check your network connection, firewall, and VPN.${PROXY_HINT}`,
  },
  {
    pattern: /ETIMEDOUT|ESOCKETTIMEDOUT|TimeoutError|operation timed out|Request timeout/i,
    message: (host) => `Connecting to ${host} timed out. Check your network connection and try again.${PROXY_HINT}`,
  },
  {
    pattern: /EPROTO|CERT_|SELF_SIGNED|UNABLE_TO_VERIFY|certificate|\bSSL\b|\bTLS\b/i,
    message: (host) =>
      `The TLS connection to ${host} failed (certificate or protocol error). If a proxy or firewall intercepts TLS, install its CA certificate or set NODE_EXTRA_CA_CERTS.`,
  },
  {
    pattern: /ECONNRESET|EPIPE|socket hang up|ERR_STREAM/i,
    message: (host) =>
      `The connection to ${host} was interrupted. Check your network connection, firewall, and VPN.${PROXY_HINT}`,
  },
]

/**
 * Translate a transport failure into something a user can act on.
 * Returns null when the error is not network related, or already carries a
 * user-facing message, so callers keep the original text.
 */
export function describeNetworkError(err: unknown, url?: string): string | null {
  if (err instanceof NetworkError) return null
  const text = errorText(err)
  if (!text) return null
  const host = hostOf(url)
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return rule.message(host)
  }
  return null
}
