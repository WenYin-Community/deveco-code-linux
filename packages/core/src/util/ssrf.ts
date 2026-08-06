export * as Ssrf from './ssrf';

import { Context, Data, Effect, Layer } from 'effect';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

export class SsrfError extends Data.TaggedError('SsrfError')<{
  readonly url: string
  readonly reason: string
}> {}

const blockedIpv4: ReadonlyArray<readonly [bigint, number]> = [
  [0n, 8], // 0.0.0.0/8 — unspecified
  [0x0a000000n, 8], // 10.0.0.0/8 — private (RFC 1918)
  [0x7f000000n, 8], // 127.0.0.0/8 — loopback
  [0xac100000n, 12], // 172.16.0.0/12 — private (RFC 1918)
  [0xc0a80000n, 16], // 192.168.0.0/16 — private (RFC 1918)
  [0xa9fe0000n, 16], // 169.254.0.0/16 — link-local (AWS/Azure/cloud metadata)
  [0x64400000n, 10], // 100.64.0.0/10 — CGNAT (Alibaba Cloud metadata)
];

const blockedIpv6: ReadonlyArray<readonly [bigint, number]> = [
  [1n, 128], // ::1/128 — loopback
  [0xfc00n << 112n, 7], // fc00::/7 — unique local
  [0xfe80n << 112n, 10], // fe80::/10 — link-local
];

// Hostnames blocked as defense-in-depth before DNS resolution. Cloud metadata
// endpoints that resolve to the link-local range above are already covered.
const blockedHostnames = new Set(['metadata']);

function ipInCidr(ip: bigint, network: bigint, maskBits: number, totalBits: number): boolean {
  if (maskBits === 0) {
    return true;
  }
  if (maskBits >= totalBits) {
    return ip === network;
  }
  const shift = BigInt(totalBits - maskBits);
  const mask = ((1n << BigInt(maskBits)) - 1n) << shift;
  return (ip & mask) === (network & mask);
}

function ipv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    return null;
  }
  let result = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const octet = Number.parseInt(part, 10);
    if (octet > 255) {
      return null;
    }
    result = (result << 8n) + BigInt(octet);
  }
  return result;
}

// Extracts an embedded IPv4 suffix (":d.d.d.d") from a lowercased IPv6 string.
// Returns the separated hex part and the parsed IPv4 bigint, or null on failure.
function splitIpv4Suffix(lower: string): { hexPart: string; ipv4Part: bigint } | null {
  if (!lower.includes('.')) {
    return null;
  }
  const lastColon = lower.lastIndexOf(':');
  if (lastColon === -1) {
    return null;
  }
  const ipv4Part = ipv4ToBigInt(lower.slice(lastColon + 1));
  if (ipv4Part === null) {
    return null;
  }
  return { hexPart: lower.slice(0, lastColon), ipv4Part };
}

// Assembles an IPv6 bigint from validated hex groups, zero-filled gaps,
// and an optional embedded IPv4 suffix.
function assembleIpv6(head: string[], tail: string[], missing: number, ipv4Part: bigint | null): bigint | null {
  let result = 0n;
  for (const group of head) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) {
      return null;
    }
    result = (result << 16n) + BigInt(Number.parseInt(group, 16));
  }
  for (let i = 0; i < missing; i++) {
    result = result << 16n;
  }
  for (const group of tail) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) {
      return null;
    }
    result = (result << 16n) + BigInt(Number.parseInt(group, 16));
  }
  if (ipv4Part !== null) {
    result = (result << 32n) + ipv4Part;
  }
  return result;
}

function ipv6ToBigInt(ip: string): bigint | null {
  const lower = ip.toLowerCase();
  const suffix = splitIpv4Suffix(lower);
  const ipv4Part = suffix?.ipv4Part ?? null;
  const hexPart = suffix?.hexPart ?? lower;

  const doubleColon = hexPart.indexOf('::');
  let head: string[];
  let tail: string[];
  if (doubleColon !== -1) {
    if (hexPart.indexOf('::', doubleColon + 1) !== -1) {
      return null;
    }
    const before = hexPart.slice(0, doubleColon);
    const after = hexPart.slice(doubleColon + 2);
    head = before === '' ? [] : before.split(':');
    tail = after === '' ? [] : after.split(':');
  } else {
    head = hexPart.split(':');
    tail = [];
  }

  const ipv4Groups = ipv4Part !== null ? 2 : 0;
  const totalGroups = 8 - ipv4Groups;
  const missing = totalGroups - head.length - tail.length;
  if (missing < 0) {
    return null;
  }
  if (doubleColon === -1 && missing !== 0) {
    return null;
  }

  return assembleIpv6(head, tail, missing, ipv4Part);
}

// ::ffff:0:0/96 — IPv4-mapped IPv6 range. The embedded IPv4 lives in the low 32 bits.
const ipv4MappedNetwork = 0xffffn << 32n;
const ipv4MappedMask = ((1n << 96n) - 1n) << 32n;

function extractIpv4Mapped(ip: bigint): bigint | null {
  if ((ip & ipv4MappedMask) !== (ipv4MappedNetwork & ipv4MappedMask)) {
    return null;
  }
  return ip & 0xffffffffn;
}

export function isBlockedIp(ip: string): boolean {
  const v4 = ipv4ToBigInt(ip);
  if (v4 !== null) {
    return blockedIpv4.some(([network, bits]) => ipInCidr(v4, network, bits, 32));
  }
  const v6 = ipv6ToBigInt(ip);
  if (v6 === null) {
    return false;
  }
  if (blockedIpv6.some(([network, bits]) => ipInCidr(v6, network, bits, 128))) {
    return true;
  }
  const mapped = extractIpv4Mapped(v6);
  if (mapped !== null) {
    return blockedIpv4.some(([network, bits]) => ipInCidr(mapped, network, bits, 32));
  }
  return false;
}

export function isBlockedHostname(hostname: string): boolean {
  return blockedHostnames.has(hostname.toLowerCase());
}

export interface Interface {
  readonly assertSafeUrl: (url: string) => Effect.Effect<void, SsrfError>
}

export class Guard extends Context.Service<Guard, Interface>()('@opencode/SsrfGuard') {}

// The guard only checks the initial URL. Effect's HttpClient follows redirects
// automatically, so a safe initial URL could redirect to an internal address.
// Redirect-based SSRF is a known limitation of this first iteration.
export const GuardLive = Layer.effect(
  Guard,
  Effect.gen(function* () {
    const assertSafeUrl = (url: string): Effect.Effect<void, SsrfError> =>
      Effect.gen(function* () {
        const hostname = yield* Effect.try({
          try: () => {
            const parsed = new URL(url);
            // WHATWG URL keeps brackets around IPv6 hostnames; strip them so isIP recognises the literal.
            return parsed.hostname.startsWith('[') ? parsed.hostname.slice(1, -1) : parsed.hostname;
          },
          catch: (error) => new SsrfError({ url, reason: `Invalid URL: ${String(error)}` }),
        });
        if (isBlockedHostname(hostname)) {
          return yield* new SsrfError({ url, reason: `Blocked hostname: ${hostname}` });
        }
        if (isIP(hostname) > 0) {
          if (isBlockedIp(hostname)) {
            return yield* new SsrfError({ url, reason: `Blocked IP literal: ${hostname}` });
          }
          return undefined;
        }
        const addresses = yield* Effect.tryPromise({
          try: () => lookup(hostname, { all: true }),
          catch: (error) => new SsrfError({ url, reason: `DNS resolution failed: ${String(error)}` }),
        });
        const blocked = addresses.find((addr) => isBlockedIp(addr.address));
        if (blocked) {
          return yield* new SsrfError({ url, reason: `Hostname resolved to blocked IP: ${blocked.address}` });
        }
        return undefined;
      });
    return Guard.of({ assertSafeUrl });
  }),
);

export const GuardTest = Layer.succeed(Guard, Guard.of({ assertSafeUrl: () => Effect.void }));
