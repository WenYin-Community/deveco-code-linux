import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Runtime } from "../src/runtime"

describe("Runtime.resolve", () => {
  test("preserves the existing default runtime", () => {
    expect(Runtime.resolve({})).toEqual({
      mode: "default",
      agentProfile: "default",
      analyticsSource: {
        sourceType: "DevEco-Code-Cli",
      },
      configSources: {
        project: true,
        home: true,
        explicit: true,
        projectInstructions: true,
        homeClaudeInstructions: true,
      },
    })
  })

  test("requires an absolute storage root for DevEco Studio", () => {
    expect(() => Runtime.resolve({ DEVECO_RUNTIME_MODE: "deveco-studio" })).toThrow("DEVECO_STORAGE_ROOT")
    expect(() => Runtime.resolve({ DEVECO_RUNTIME_MODE: "deveco-studio", DEVECO_STORAGE_ROOT: "relative" })).toThrow(
      "absolute path",
    )
  })

  test("isolates Studio persistence and client-owned configuration sources", () => {
    const root = path.resolve("studio-profile")
    expect(
      Runtime.resolve({
        DEVECO_RUNTIME_MODE: "deveco-studio",
        DEVECO_STORAGE_ROOT: root,
        DEVECO_SOURCE_TYPE: "DevEco-Code-Plugin",
        DEVECO_SOURCE_VERSION: "6.0.1.100",
      }),
    ).toEqual({
      mode: "deveco-studio",
      storageRoot: root,
      agentProfile: "deveco-studio",
      analyticsSource: {
        sourceType: "DevEco-Code-Plugin",
        sourceVersion: "6.0.1.100",
      },
      configSources: {
        project: false,
        home: false,
        explicit: false,
        projectInstructions: true,
        homeClaudeInstructions: false,
      },
    })
  })

  test("keeps CLI analytics metadata in default mode", () => {
    expect(
      Runtime.resolve({
        DEVECO_SOURCE_TYPE: "DevEco-Code-Plugin",
        DEVECO_SOURCE_VERSION: "6.0.1.100",
      }).analyticsSource,
    ).toEqual({ sourceType: "DevEco-Code-Cli" })
  })

  test("validates Studio analytics metadata without blocking a missing version", () => {
    const root = path.resolve("studio-profile")
    expect(
      Runtime.resolve({
        DEVECO_RUNTIME_MODE: "deveco-studio",
        DEVECO_STORAGE_ROOT: root,
      }).analyticsSource,
    ).toEqual({ sourceType: "DevEco-Code-Plugin", sourceVersion: "unknown" })
    expect(() =>
      Runtime.resolve({
        DEVECO_RUNTIME_MODE: "deveco-studio",
        DEVECO_STORAGE_ROOT: root,
        DEVECO_SOURCE_TYPE: "arbitrary-client",
      }),
    ).toThrow("Unsupported DEVECO_SOURCE_TYPE")
  })

  test("rejects unknown runtime modes", () => {
    expect(() => Runtime.resolve({ DEVECO_RUNTIME_MODE: "other" })).toThrow("Unsupported DEVECO_RUNTIME_MODE")
  })

  test("routes global paths and the database before services initialize", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "deveco-studio-runtime-"))
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        [
          `const { Runtime } = await import(${JSON.stringify(new URL("../src/runtime.ts", import.meta.url).href)})`,
          `const { Global } = await import(${JSON.stringify(new URL("../src/global.ts", import.meta.url).href)})`,
          `const { Database } = await import(${JSON.stringify(new URL("../src/database/database.ts", import.meta.url).href)})`,
        'console.log(JSON.stringify({ paths: Global.Path, projectConfig: Global.projectConfig("project/id"), database: Database.path(), analytics: Runtime.getAnalyticsSource("1.17.9") }))',
        ].join(";"),
      ],
      {
        env: {
          ...process.env,
          DEVECO_RUNTIME_MODE: "deveco-studio",
          DEVECO_STORAGE_ROOT: root,
          DEVECO_SOURCE_TYPE: "DevEco-Code-Plugin",
          DEVECO_SOURCE_VERSION: "6.0.1.100",
          DEVECO_DB: path.join(os.tmpdir(), "must-not-be-used.db"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const output = JSON.parse(await new Response(child.stdout).text())
    expect(await child.exited).toBe(0)
    expect(output.paths).toMatchObject({
      data: path.join(root, "data"),
      config: path.join(root, "config"),
      state: path.join(root, "state"),
      cache: path.join(root, "cache"),
      tmp: path.join(root, "tmp"),
    })
    expect(output.database.startsWith(path.join(root, "data") + path.sep)).toBe(true)
    expect(output.projectConfig).toBe(path.join(root, "config", "projects", "project_id", ".deveco"))
    expect(output.analytics).toEqual({ sourceType: "DevEco-Code-Plugin", sourceVersion: "6.0.1.100" })
    await fs.rm(root, { recursive: true, force: true })
  })
})
