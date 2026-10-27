import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(FSUtil.defaultLayer)

// `isDir` folds every stat failure into "no", which is enough to answer "can I open this?" but not
// enough for callers that react to a missing directory by relocating state: a permission problem
// would look exactly like a deleted checkout. `checkDir` therefore has to tell the three cases
// apart, and these cases pin that down.
describe("FSUtil.checkDir", () => {
  const withTmp = <A, E, R>(f: (directory: string) => Effect.Effect<A, E, R>) =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(Effect.flatMap((tmp) => f(tmp.path)))

  it.live("reports an existing directory as available", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(directory, "checkout")))
        const result = yield* FSUtil.Service.use((fsu) => fsu.checkDir(path.join(directory, "checkout")))
        expect(result).toBe("available")
      }),
    ),
  )

  it.live("reports a directory that is gone as missing", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const result = yield* FSUtil.Service.use((fsu) => fsu.checkDir(path.join(directory, "never-existed")))
        expect(result).toBe("missing")
      }),
    ),
  )

  // A file where the checkout used to be is not something that can be opened either, and callers
  // treat both the same way: the state that pointed here has to move.
  it.live("reports a file in place of the directory as missing", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const file = path.join(directory, "not-a-directory")
        yield* Effect.promise(() => fs.writeFile(file, "x"))
        const result = yield* FSUtil.Service.use((fsu) => fsu.checkDir(file))
        expect(result).toBe("missing")
        // `isDir` cannot tell the two cases apart, which is why `checkDir` exists.
        expect(yield* FSUtil.Service.use((fsu) => fsu.isDir(file))).toBe(false)
      }),
    ),
  )

  it.live("reports a directory it may not inspect as unreadable", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        // Permissions do not stop root, so the state under test is unreachable there.
        if (process.getuid?.() === 0) return

        const parent = path.join(directory, "locked")
        const checkout = path.join(parent, "checkout")
        yield* Effect.promise(() => fs.mkdir(parent))
        yield* Effect.promise(() => fs.mkdir(checkout))
        // Restore the mode first, otherwise the temporary directory cannot be removed.
        yield* Effect.addFinalizer(() => Effect.promise(() => fs.chmod(parent, 0o755)).pipe(Effect.ignore))
        yield* Effect.promise(() => fs.chmod(parent, 0o000))

        const result = yield* FSUtil.Service.use((fsu) => fsu.checkDir(checkout))
        expect(result).toBe("unreadable")
        // Same input, and `isDir` reports "no": the distinction only exists in `checkDir`.
        expect(yield* FSUtil.Service.use((fsu) => fsu.isDir(checkout))).toBe(false)
      }),
    ),
  )

  // `stat` only needs the ancestors to be searchable, so a directory whose own mode denies access
  // stats fine and used to be reported as "available"; the failure showed up much later, on the
  // first `readdir`, as a defect the caller could not classify. The readability probe is what
  // turns this case into "unreadable".
  it.live("reports a directory whose own mode denies access as unreadable", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        // Permissions do not stop root, so the state under test is unreachable there.
        if (process.getuid?.() === 0) return

        const checkout = path.join(directory, "private")
        yield* Effect.promise(() => fs.mkdir(checkout))
        // Restore the mode first, otherwise the temporary directory cannot be removed.
        yield* Effect.addFinalizer(() => Effect.promise(() => fs.chmod(checkout, 0o755)).pipe(Effect.ignore))
        yield* Effect.promise(() => fs.chmod(checkout, 0o000))

        // The stat below is the blind spot: it succeeds on a directory nobody may read.
        expect((yield* Effect.promise(() => fs.stat(checkout))).isDirectory()).toBe(true)
        const result = yield* FSUtil.Service.use((fsu) => fsu.checkDir(checkout))
        expect(result).toBe("unreadable")
      }),
    ),
  )
})
