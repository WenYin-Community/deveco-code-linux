import { expect, test } from "bun:test"
import { getAnalyticsDeviceId } from "@/plugin/analytics/device-id"

function iface(mac: string, internal = false) {
  return {
    mac,
    internal,
    address: "192.168.1.1",
    netmask: "255.255.255.0",
    family: "IPv4" as const,
    cidr: "192.168.1.1/24",
  }
}

const fallback = async () => "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"

test("same MAC with colon, dash separators and mixed case produces identical id", async () => {
  const colon = await getAnalyticsDeviceId(() => ({ eth0: [iface("02:BB:CC:DD:EE:FF")] }), fallback)
  const dash = await getAnalyticsDeviceId(() => ({ eth0: [iface("02-bb-cc-dd-ee-ff")] }), fallback)
  const bare = await getAnalyticsDeviceId(() => ({ eth0: [iface("02bbccddeeff")] }), fallback)
  expect(colon).toBe(dash)
  expect(dash).toBe(bare)
})

test("result matches 32-char lowercase hex without dashes", async () => {
  const id = await getAnalyticsDeviceId(() => ({ eth0: [iface("02:bb:cc:dd:ee:ff")] }), fallback)
  expect(id).toMatch(/^[0-9a-f]{32}$/)
  expect(id).not.toContain("-")
})

test("known MAC produces expected SHA-256 prefix", async () => {
  const id = await getAnalyticsDeviceId(() => ({ eth0: [iface("02:bb:cc:dd:ee:ff")] }), fallback)
  expect(id).toBe("237939795f5484335c1ca5a835a44bf3")
})

test("internal interfaces are ignored", async () => {
  const id = await getAnalyticsDeviceId(
    () => ({
      lo: [
        {
          mac: "02:22:33:44:55:66",
          internal: true,
          address: "127.0.0.1",
          netmask: "255.0.0.0",
          family: "IPv4" as const,
          cidr: "127.0.0.1/8",
        },
      ],
    }),
    fallback,
  )
  expect(id).toBe("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6")
})

test("loopback-named interfaces are ignored", async () => {
  const id = await getAnalyticsDeviceId(() => ({ Loopback: [iface("02:22:33:44:55:66")] }), fallback)
  expect(id).toBe("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6")
})

test("all-zero MAC is ignored", async () => {
  const id = await getAnalyticsDeviceId(() => ({ eth0: [iface("00:00:00:00:00:00")] }), fallback)
  expect(id).toBe("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6")
})

test("broadcast MAC is ignored", async () => {
  const id = await getAnalyticsDeviceId(() => ({ eth0: [iface("ff:ff:ff:ff:ff:ff")] }), fallback)
  expect(id).toBe("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6")
})

test("multicast MAC is ignored", async () => {
  const id = await getAnalyticsDeviceId(() => ({ eth0: [iface("01:00:5e:00:00:01")] }), fallback)
  expect(id).toBe("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6")
})

test("invalid MAC format is ignored", async () => {
  const id = await getAnalyticsDeviceId(() => ({ eth0: [iface("xx:xx:xx:xx:xx:xx")] }), fallback)
  expect(id).toBe("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6")
})

test("multi-NIC enumeration order does not affect result", async () => {
  const order1 = await getAnalyticsDeviceId(
    () => ({ eth0: [iface("02:bb:cc:dd:ee:ff")], eth1: [iface("02:22:33:44:55:66")] }),
    fallback,
  )
  const order2 = await getAnalyticsDeviceId(
    () => ({ eth1: [iface("02:22:33:44:55:66")], eth0: [iface("02:bb:cc:dd:ee:ff")] }),
    fallback,
  )
  expect(order1).toBe(order2)
  expect(order1).toBe("86109d7af14a39b82605d3750a34795a")
})

test("duplicate MACs are deduplicated", async () => {
  const id = await getAnalyticsDeviceId(
    () => ({ eth0: [iface("02:bb:cc:dd:ee:ff")], eth1: [iface("02:bb:cc:dd:ee:ff")] }),
    fallback,
  )
  expect(id).toBe("237939795f5484335c1ca5a835a44bf3")
})

test("fallback standard UUID produces 32-char hex without dashes", async () => {
  const id = await getAnalyticsDeviceId(
    () => ({}),
    async () => "a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5d6",
  )
  expect(id).toBe("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6")
  expect(id).toMatch(/^[0-9a-f]{32}$/)
  expect(id).not.toContain("-")
})

test("fallback uppercase UUID is normalized to lowercase", async () => {
  const id = await getAnalyticsDeviceId(
    () => ({}),
    async () => "A1B2C3D4-E5F6-A7B8-C9D0-E1F2A3B4C5D6",
  )
  expect(id).toBe("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6")
  expect(id).toMatch(/^[0-9a-f]{32}$/)
})

test("fallback arbitrary string is hashed to stable 32-char hex", async () => {
  const id = await getAnalyticsDeviceId(
    () => ({}),
    async () => "some-old-device-id",
  )
  expect(id).toBe("d7dfd597d5d45856ed3c92f86ef6306c")
  expect(id).toMatch(/^[0-9a-f]{32}$/)
})

test("fallback same historical string returns same result", async () => {
  const fb = async () => "legacy-device-identifier"
  const first = await getAnalyticsDeviceId(() => ({}), fb)
  const second = await getAnalyticsDeviceId(() => ({}), fb)
  expect(first).toBe(second)
  expect(first).toMatch(/^[0-9a-f]{32}$/)
})

test("reader exception falls back to persisted device ID", async () => {
  const throwingReader = () => {
    throw new Error("network interface unavailable")
  }
  const id = await getAnalyticsDeviceId(throwingReader, fallback)
  expect(id).toBe("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6")
  expect(id).toMatch(/^[0-9a-f]{32}$/)
})
