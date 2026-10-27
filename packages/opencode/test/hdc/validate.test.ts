import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { HdcValidate } from "../../src/hdc/validate"

async function makeWorktree(): Promise<{ worktree: string; clean(): Promise<void> }> {
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "hdc-validate-"))
  return { worktree, clean: () => fs.rm(worktree, { recursive: true, force: true }) }
}

describe("hdc validate", () => {
  describe("validateLocalReadFile", () => {
    test("accepts a regular file inside the worktree and captures identity", async () => {
      const { worktree, clean } = await makeWorktree()
      try {
        const file = path.join(worktree, "app.hap")
        await fs.writeFile(file, "package bytes")

        const result = HdcValidate.validateLocalReadFile(worktree, worktree, "app.hap")
        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.value.realPath).toBe(await fs.realpath(file))
        expect(result.value.identity.size).toBe(13)
      } finally {
        await clean()
      }
    })

    test("resolves relative to cwd and rejects escapes", async () => {
      const { worktree, clean } = await makeWorktree()
      const sibling = await fs.mkdtemp(path.join(os.tmpdir(), "hdc-validate-out-"))
      try {
        await fs.writeFile(path.join(worktree, "inside.hap"), "x")
        await fs.writeFile(path.join(sibling, "outside.hap"), "x")
        const sub = path.join(worktree, "sub")
        await fs.mkdir(sub)

        const inside = HdcValidate.validateLocalReadFile(sub, worktree, "../inside.hap")
        expect(inside.ok).toBe(true)

        const outside = HdcValidate.validateLocalReadFile(sub, worktree, "../../" + path.basename(sibling) + "/outside.hap")
        expect(outside.ok).toBe(false)
        if (outside.ok) return
        expect(outside.message).toContain("escapes the worktree")
      } finally {
        await clean()
        await fs.rm(sibling, { recursive: true, force: true })
      }
    })

    test.skipIf(process.platform === "win32")("rejects missing paths, directories, and symlink escapes", async () => {
      const { worktree, clean } = await makeWorktree()
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "hdc-validate-out-"))
      try {
        const missing = HdcValidate.validateLocalReadFile(worktree, worktree, "missing.hap")
        expect(missing.ok).toBe(false)

        const dir = HdcValidate.validateLocalReadFile(worktree, worktree, ".")
        expect(dir.ok).toBe(false)

        // Unprivileged Windows cannot create file symlinks; unix CI
        // covers the symlink-escape path.
        const target = path.join(outside, "real.hap")
        await fs.writeFile(target, "x")
        const link = path.join(worktree, "link.hap")
        await fs.symlink(target, link)
        const viaLink = HdcValidate.validateLocalReadFile(worktree, worktree, "link.hap")
        expect(viaLink.ok).toBe(false)
      } finally {
        await clean()
        await fs.rm(outside, { recursive: true, force: true })
      }
    })
  })

  describe("validateLocalWritePath", () => {
    test("accepts existing and not-yet-existing paths inside the worktree", async () => {
      const { worktree, clean } = await makeWorktree()
      try {
        await fs.writeFile(path.join(worktree, "exists.txt"), "x")
        expect(HdcValidate.validateLocalWritePath(worktree, worktree, "exists.txt").ok).toBe(true)
        expect(HdcValidate.validateLocalWritePath(worktree, worktree, path.join("new", "nested", "file.txt")).ok).toBe(true)
      } finally {
        await clean()
      }
    })

    test("rejects escapes via a symlinked/junctioned parent", async () => {
      const { worktree, clean } = await makeWorktree()
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "hdc-validate-out-"))
      try {
        // Windows junctions need no extra privilege and realpath
        // resolves them the same way as unix dir symlinks.
        await fs.symlink(outside, path.join(worktree, "outsidelink"), process.platform === "win32" ? "junction" : "dir")
        const result = HdcValidate.validateLocalWritePath(worktree, worktree, path.join("outsidelink", "file.txt"))
        expect(result.ok).toBe(false)
      } finally {
        await clean()
        await fs.rm(outside, { recursive: true, force: true })
      }
    })
  })

  describe("identityMatches (CON-03 TOCTOU)", () => {
    test("matches an untouched file and detects swaps", async () => {
      const { worktree, clean } = await makeWorktree()
      try {
        const file = path.join(worktree, "app.hap")
        await fs.writeFile(file, "v1")
        const result = HdcValidate.validateLocalReadFile(worktree, worktree, "app.hap")
        if (!result.ok) throw new Error("expected ok")
        const { realPath, identity } = result.value

        expect(HdcValidate.identityMatches(realPath, identity)).toBe(true)

        await fs.writeFile(file, "v2 with different size")
        expect(HdcValidate.identityMatches(realPath, identity)).toBe(false)

        await fs.rm(file)
        expect(HdcValidate.identityMatches(realPath, identity)).toBe(false)
      } finally {
        await clean()
      }
    })
  })

  describe("validateRemotePath", () => {
    const allowedRoots = ["/data/local/tmp/"]

    test("requires absolute normalization-safe paths", () => {
      expect(HdcValidate.validateRemotePath("/data/local/tmp/file.txt", allowedRoots).ok).toBe(true)
      expect(HdcValidate.validateRemotePath("relative/path", allowedRoots).ok).toBe(false)
      expect(HdcValidate.validateRemotePath("/a/../b", allowedRoots).ok).toBe(false)
      expect(HdcValidate.validateRemotePath("/has/../..", allowedRoots).ok).toBe(false)
      expect(HdcValidate.validateRemotePath("/bad\0path", allowedRoots).ok).toBe(false)
    })

    test("must stay under a device-allowed root", () => {
      const inRoot = HdcValidate.validateRemotePath("/data/local/tmp/deveco/file.txt", allowedRoots)
      expect(inRoot.ok).toBe(true)

      // The allowed root itself is in bounds.
      expect(HdcValidate.validateRemotePath("/data/local/tmp/", allowedRoots).ok).toBe(true)

      const outside = HdcValidate.validateRemotePath("/system/bin/tool", allowedRoots)
      expect(outside.ok).toBe(false)
      if (outside.ok) return
      expect(outside.message).toContain("device-allowed")
    })

    test("prefix-equal paths outside the trailing-slash root are rejected", () => {
      // "/data/local/tmp" does not start with "/data/local/tmp/" and is
      // not the root itself, so it stays out of bounds.
      expect(HdcValidate.validateRemotePath("/data/local/tmp", allowedRoots).ok).toBe(false)
      expect(HdcValidate.validateRemotePath("/data/local/tmp-evil/file.txt", allowedRoots).ok).toBe(false)
    })
  })
})
