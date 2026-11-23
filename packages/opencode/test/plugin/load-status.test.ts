import { expect, test } from "bun:test"
import { clear, lookup, record, snapshot } from "@/plugin/load-status"

test("keeps the load record the plugin layer reported for a spec", () => {
  const directory = "/work/record"
  record(directory, "oh-my-opencode", { loadStatus: "failed", failureStage: "install" })
  expect(lookup(directory, "oh-my-opencode")).toEqual({ loadStatus: "failed", failureStage: "install" })
})

test("the last record reported for a spec wins", () => {
  const directory = "/work/last-write"
  record(directory, "@acme/plugin", { loadStatus: "failed", failureStage: "compatibility" })
  record(directory, "@acme/plugin", { loadStatus: "loaded", failureStage: "" })
  expect(lookup(directory, "@acme/plugin")).toEqual({ loadStatus: "loaded", failureStage: "" })
})

test("reports nothing for a spec or directory it never saw", () => {
  const directory = "/work/never-recorded"
  expect(lookup(directory, "@acme/unknown")).toBeUndefined()
  expect(snapshot(directory)).toEqual({})
})

test("does not mix records between directories", () => {
  const left = "/work/left"
  const right = "/work/right"
  record(left, "@acme/shared", { loadStatus: "loaded", failureStage: "" })
  record(right, "@acme/shared", { loadStatus: "missing", failureStage: "" })
  expect(lookup(left, "@acme/shared")).toEqual({ loadStatus: "loaded", failureStage: "" })
  expect(lookup(right, "@acme/shared")).toEqual({ loadStatus: "missing", failureStage: "" })
  expect(Object.keys(snapshot(left))).toEqual(["@acme/shared"])
  expect(Object.keys(snapshot(right))).toEqual(["@acme/shared"])
})

test("treats different spec spellings as different plugins", () => {
  // The plugin layer reports by the spec written in the config and analytics looks that same spec
  // up, so the registry must not normalize a range away: normalizing "@1.0.0" to the bare name
  // would report every version-pinned npm plugin as never loaded.
  const directory = "/work/spec-spelling"
  record(directory, "@acme/pinned@1.0.0", { loadStatus: "loaded", failureStage: "" })
  expect(lookup(directory, "@acme/pinned")).toBeUndefined()
  expect(snapshot(directory)).toEqual({ "@acme/pinned@1.0.0": { loadStatus: "loaded", failureStage: "" } })
})

test("snapshot hands back a copy that cannot rewrite the records", () => {
  const directory = "/work/snapshot-copy"
  record(directory, "@acme/a", { loadStatus: "loaded", failureStage: "" })
  const copied = snapshot(directory)
  copied["@acme/a"] = { loadStatus: "missing", failureStage: "" }
  expect(lookup(directory, "@acme/a")).toEqual({ loadStatus: "loaded", failureStage: "" })
})

test("clear forgets one directory and leaves the others", () => {
  const target = "/work/clear-target"
  const other = "/work/clear-other"
  record(target, "@acme/a", { loadStatus: "loaded", failureStage: "" })
  record(other, "@acme/a", { loadStatus: "failed", failureStage: "server" })
  clear(target)
  expect(snapshot(target)).toEqual({})
  expect(lookup(other, "@acme/a")).toEqual({ loadStatus: "failed", failureStage: "server" })
})
