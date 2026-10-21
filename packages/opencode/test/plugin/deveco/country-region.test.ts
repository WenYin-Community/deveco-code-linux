import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  COUNTRY_REGION_FILE,
  RENAME_RETRY_DELAYS_MS,
  countryRegionDir,
  countryRegionFileIsUsable,
  countryRegionFilePath,
  renameWithRetry,
  renderCountryRegionXml,
  saveCountryRegion,
} from "@/plugin/deveco/country-region"

/** Codes the product may store: CN plus the other regions the auth server can report. */
const COUNTRY_CODES = ["CN", "JP", "UK", "HK", "MO"]

function expectedDocument(countryCode: string): string {
  return [
    "<application>",
    '  <component name="CountryRegionSetting">',
    `    <countryregion name="${countryCode}"/>`,
    "  </component>",
    "</application>",
    "",
  ].join("\n")
}

function renameError(code: string): Error {
  return Object.assign(new Error(`rename failed with ${code}`), { code })
}

function errorCodeOf(value: unknown): string | undefined {
  return value instanceof Error && "code" in value && typeof value.code === "string" ? value.code : undefined
}

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "deveco-country-region-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("renderCountryRegionXml", () => {
  test("renders the document for every supported region", () => {
    for (const code of COUNTRY_CODES) expect(renderCountryRegionXml(code)).toBe(expectedDocument(code))
  })

  test("normalises case and surrounding whitespace", () => {
    expect(renderCountryRegionXml(" cn ")).toBe(expectedDocument("CN"))
    expect(renderCountryRegionXml("jp")).toBe(expectedDocument("JP"))
    expect(renderCountryRegionXml("uk")).toBe(expectedDocument("UK"))
    expect(renderCountryRegionXml(" hk ")).toBe(expectedDocument("HK"))
    expect(renderCountryRegionXml("mo")).toBe(expectedDocument("MO"))
  })

  test("rejects values that are not two-letter codes", () => {
    // "ß" is listed because toUpperCase() folds it to "SS"; the shape check must run first.
    const rejected = ["", "   ", "C", "CHN", "C1", 'CN"', "CN\n<component/>", "c n", "ß"]
    for (const code of rejected) expect(renderCountryRegionXml(code)).toBeNull()
  })
})

describe("countryRegionFileIsUsable", () => {
  test("reports whether the document is present", async () => {
    expect(await countryRegionFileIsUsable(dir)).toBe(false)
    await saveCountryRegion("JP", dir)
    expect(await countryRegionFileIsUsable(dir)).toBe(true)
  })

  test("treats unusable objects as missing", async () => {
    // A directory squatting on the path: an existence check calls this present, writing fails.
    await fs.mkdir(countryRegionFilePath(dir), { recursive: true })
    expect(await countryRegionFileIsUsable(dir)).toBe(false)

    await fs.rm(countryRegionFilePath(dir), { recursive: true, force: true })

    // Zero bytes, as left by a power loss or restored by a backup agent.
    await fs.writeFile(countryRegionFilePath(dir), "")
    expect(await countryRegionFileIsUsable(dir)).toBe(false)
  })

  test("leaves content written by another tool alone", async () => {
    // DevEco Studio owns the file as well; anything with content counts as usable.
    await fs.writeFile(countryRegionFilePath(dir), "<not-our-format/>")
    expect(await countryRegionFileIsUsable(dir)).toBe(true)
  })
})

describe("countryRegionFilePath", () => {
  test("returns the document path inside the config directory", () => {
    expect(COUNTRY_REGION_FILE).toBe("country.region.xml")
    expect(countryRegionFilePath("/tmp/example")).toBe(path.join("/tmp/example", "country.region.xml"))
  })

  test("defaults to <home>/.config/deveco on every platform", () => {
    const home = process.env.DEVECO_TEST_HOME ?? os.homedir()
    expect(countryRegionDir()).toBe(path.join(home, ".config", "deveco"))
    expect(countryRegionFilePath()).toBe(path.join(home, ".config", "deveco", "country.region.xml"))
  })
})

describe("saveCountryRegion", () => {
  test("creates the directory and writes the document", async () => {
    const configDir = path.join(dir, "nested", "deveco")

    expect(await saveCountryRegion("JP", configDir)).toBe(true)
    expect(await Bun.file(path.join(configDir, "country.region.xml")).text()).toBe(expectedDocument("JP"))
  })

  test("writes every supported region", async () => {
    for (const code of COUNTRY_CODES) {
      expect(await saveCountryRegion(code, dir)).toBe(true)
      expect(await Bun.file(countryRegionFilePath(dir)).text()).toBe(expectedDocument(code))
    }
    expect(await fs.readdir(dir)).toEqual(["country.region.xml"])
  })

  test("replaces an existing document without leaving a temp file", async () => {
    await saveCountryRegion("HK", dir)
    await saveCountryRegion("mo", dir)

    expect(await fs.readdir(dir)).toEqual(["country.region.xml"])
    expect(await Bun.file(path.join(dir, "country.region.xml")).text()).toBe(expectedDocument("MO"))
  })

  test("writes nothing when the code is rejected", async () => {
    expect(await saveCountryRegion("Germany", dir)).toBe(false)
    expect(await fs.readdir(dir)).toEqual([])
  })

  test("throws when the directory cannot be created", async () => {
    const blocker = path.join(dir, "blocker")
    await fs.writeFile(blocker, "not a directory")

    const failure = await saveCountryRegion("CN", path.join(blocker, "deveco")).catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(Error)
  })

  test("retries a rename blocked by a sharing violation", async () => {
    let attempts = 0
    const flaky = async (from: string, to: string) => {
      attempts += 1
      if (attempts < 3) throw renameError("EBUSY")
      await fs.rename(from, to)
    }

    expect(await saveCountryRegion("UK", dir, flaky)).toBe(true)
    expect(attempts).toBe(3)
    expect(await Bun.file(countryRegionFilePath(dir)).text()).toBe(expectedDocument("UK"))
    expect(await fs.readdir(dir)).toEqual(["country.region.xml"])
  })

  test("reports the failure and cleans up when the rename never succeeds", async () => {
    let attempts = 0
    const blocked = async () => {
      attempts += 1
      throw renameError("EPERM")
    }

    const failure = await saveCountryRegion("MO", dir, blocked).catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(Error)
    expect(errorCodeOf(failure)).toBe("EPERM")
    expect(attempts).toBe(RENAME_RETRY_DELAYS_MS.length + 1)
    expect(await fs.readdir(dir)).toEqual([])
  })
})

describe("renameWithRetry", () => {
  test("retries the retryable error codes", async () => {
    const calls: string[] = []
    const rename = async () => {
      const code = ["EPERM", "EACCES", "EBUSY"][calls.length]
      calls.push(code ?? "ok")
      if (code) throw renameError(code)
    }

    await renameWithRetry("from", "to", rename)
    expect(calls).toEqual(["EPERM", "EACCES", "EBUSY", "ok"])
  })

  test("does not retry unrelated errors", async () => {
    let attempts = 0
    const rename = async () => {
      attempts += 1
      throw renameError("ENOENT")
    }

    const failure = await renameWithRetry("from", "to", rename).catch((err: unknown) => err)
    expect(errorCodeOf(failure)).toBe("ENOENT")
    expect(attempts).toBe(1)
  })

  test("does not retry a rejection that carries no error code", async () => {
    let attempts = 0
    const rename = async () => {
      attempts += 1
      throw "EPERM"
    }

    await renameWithRetry("from", "to", rename).catch(() => undefined)
    expect(attempts).toBe(1)
  })

  test("gives up once the retry budget is spent", async () => {
    let attempts = 0
    const rename = async () => {
      attempts += 1
      throw renameError("EACCES")
    }

    const failure = await renameWithRetry("from", "to", rename).catch((err: unknown) => err)
    expect(errorCodeOf(failure)).toBe("EACCES")
    expect(attempts).toBe(RENAME_RETRY_DELAYS_MS.length + 1)
  })
})
