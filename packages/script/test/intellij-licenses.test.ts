// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { copyLicenses } from "../src/license"

const pythonCandidates =
  process.platform === "win32" ? [["py", "-3"], ["python3"], ["python"]] : [["python3"], ["python"]]
const python =
  pythonCandidates.find(([command, ...args]) => {
    const executable = Bun.which(command)
    if (!executable) return false
    try {
      return (
        Bun.spawnSync([
          executable,
          ...args,
          "-c",
          "import sys; sys.exit(0 if sys.version_info >= (3, 6) and sys.version_info.major == 3 else 1)",
        ]).exitCode === 0
      )
    } catch {
      return false
    }
  }) ?? []

if (python.length === 0) {
  console.warn("Skipping IntelliJ ZIP license tests. Python 3.6 or later is required.")
}

// ZIP fixtures exercise the same verifier used before upload.
test.skipIf(python.length === 0).each([
  ["accepts a valid archive", "valid", 0, ""],
  ["rejects a missing notice in the main JAR", "missing", 1, "missing license files: META-INF/deveco/NOTICE"],
  ["rejects altered license content", "modified", 1, "license content mismatch: META-INF/deveco/NOTICE"],
  ["rejects an incorrect archive count", "count", 1, "Expected 2 plugin ZIPs, found 1"],
] as const)(
  "plugin ZIP verification %s",
  async (_name, mode, exitCode, error) => {
    const directory = await mkdtemp(path.join(tmpdir(), "deveco-plugin-license-test-"))
    try {
      await copyLicenses(path.join(directory, "repository"))
      const fixture = Bun.spawnSync([
        ...python,
        "-c",
        `
import io, sys
from pathlib import Path
from zipfile import ZipFile
directory, mode = Path(sys.argv[1]), sys.argv[2]

def jar_contents(omit_notice=False):
    contents = io.BytesIO()
    with ZipFile(contents, "w") as jar:
        for name in ("LICENSE", "LICENSING.md", "NOTICE", "LICENSES/MIT.txt"):
            if omit_notice and name == "NOTICE":
                continue
            data = (directory / "repository" / name).read_bytes()
            jar.writestr("META-INF/deveco/" + name, b"incorrect notice" if mode == "modified" and name == "NOTICE" else data)
    return contents.getvalue()

with ZipFile(directory / "plugin.zip", "w") as archive:
    if mode == "missing":
        archive.writestr("plugin/lib/dependency.jar", jar_contents())
    archive.writestr("plugin/lib/deveco-code-jetbrains-plugin-1.0.0.jar", jar_contents(omit_notice=mode == "missing"))
`,
        directory,
        mode,
      ])
      expect(fixture.exitCode).toBe(0)
      const verified = Bun.spawnSync([
        ...python,
        fileURLToPath(new URL("../../../integrations/intellij-plugin/script/verify-licenses.py", import.meta.url)),
        directory,
        "--repository",
        path.join(directory, "repository"),
        "--expected-count",
        mode === "count" ? "2" : "1",
      ])
      expect(verified.exitCode).toBe(exitCode)
      if (error) expect(verified.stderr.toString()).toContain(error)
    } finally {
      expect(path.dirname(directory)).toBe(tmpdir())
      expect(path.basename(directory).startsWith("deveco-plugin-license-test-")).toBe(true)
      await rm(directory, { recursive: true, force: true })
    }
  },
  30_000,
)

