// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import opencode from "../../opencode/package.json"
import repository from "../../../package.json"
import { copyLicenses, packWithLicenses } from "../src/license"
import { generateNotice } from "../../opencode/script/generate-notice"

test("project license metadata matches the Apache license shipped with the MIT notices", async () => {
  expect(repository.license).toBe("Apache-2.0")
  expect(opencode.license).toBe(repository.license)
  const directory = await mkdtemp(path.join(tmpdir(), "deveco-license-test-"))
  try {
    await copyLicenses(directory)
    const license = await Bun.file(path.join(directory, "LICENSE")).text()
    expect(license).toBe(await Bun.file(new URL("../../../LICENSE", import.meta.url)).text())
    expect(license).toContain("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION")
    expect(license).not.toContain("MIT License")
    expect(license).not.toContain("\r")
    expect(await Bun.file(path.join(directory, "LICENSES/MIT.txt")).text()).toContain("Copyright (c) 2025 opencode")
  } finally {
    expect(path.dirname(directory)).toBe(tmpdir())
    expect(path.basename(directory).startsWith("deveco-license-test-")).toBe(true)
    await rm(directory, { recursive: true, force: true })
  }
})

test("standalone npm packs include the licensing files and clean up staged copies", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "deveco-license-pack-"))
  try {
    await Bun.write(
      path.join(directory, "package.json"),
      JSON.stringify({
        name: "deveco-license-pack",
        version: "1.0.0",
        license: "Apache-2.0",
        files: ["LICENSING.md", "NOTICE", "LICENSES/MIT.txt"],
      }),
    )
    await packWithLicenses(directory)
    const entries = Bun.spawnSync(["tar", "-tzf", path.join(directory, "deveco-license-pack-1.0.0.tgz")])
    expect(entries.exitCode).toBe(0)
    for (const file of ["LICENSE", "LICENSING.md", "NOTICE", "LICENSES/MIT.txt"]) {
      expect(entries.stdout.toString().split(/\r?\n/)).toContain(`package/${file}`)
      expect(await Bun.file(path.join(directory, file)).exists()).toBe(false)
    }
  } finally {
    expect(path.dirname(directory)).toBe(tmpdir())
    expect(path.basename(directory).startsWith("deveco-license-pack-")).toBe(true)
    await rm(directory, { recursive: true, force: true })
  }
})

test("regenerating NOTICE preserves the licensing policy, upstream attribution, and third-party sections", async () => {
  const notice = generateNotice(
    new Map([
      [
        "example@1.0.0",
        {
          name: "example",
          version: "1.0.0",
          license: "Apache-2.0",
          publisher: "Example Contributors",
          repository: "",
        },
      ],
    ]),
  )
  const separator = "THIRD-PARTY SOFTWARE NOTICES AND INFORMATION"
  expect(notice.split(separator)[0]).toBe(
    (await Bun.file(new URL("../../../NOTICE", import.meta.url)).text()).replaceAll("\r\n", "\n").split(separator)[0],
  )
  expect(notice).toContain("LICENSING.md")
  expect(notice).toContain("Copyright (c) 2025 opencode")
  expect(notice).not.toContain("This project is licensed under the MIT License.")
  expect(notice).toContain("The following components are licensed under the Apache License 2.0:")
  expect(notice).toContain("example (1.0.0) - Copyright (c) Example Contributors")
})
