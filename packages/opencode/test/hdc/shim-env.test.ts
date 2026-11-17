import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

test.each(["PATH", "Path"] as const)("preserves ambient %s in the TUI worker", async (key) => {
  await using tmp = await tmpdir()
  const current = [path.join(tmp.path, "system-bin"), path.join(tmp.path, "node-bin")]
  const result = await shellEnv(tmp.path, { [key]: current.join(path.delimiter) })

  expect(result.PATH.split(path.delimiter)).toEqual([result.bin, ...current])
})

test.each(["PATH", "Path"] as const)("preserves an earlier hook's %s in the TUI worker", async (key) => {
  await using tmp = await tmpdir()
  const current = [path.join(tmp.path, "other-shim"), path.join(tmp.path, "system-bin")]
  const result = await shellEnv(
    tmp.path,
    { Path: path.join(tmp.path, "ambient-bin") },
    { [key]: current.join(path.delimiter) },
  )

  expect(result.PATH.split(path.delimiter)).toEqual([result.bin, ...current])
})

async function shellEnv(directory: string, ambient: Record<string, string>, upstream = {}) {
  const worker = new Worker(
    `data:text/javascript,${encodeURIComponent(`
      import { HdcGuardEnvPlugin } from ${JSON.stringify(new URL("../../src/plugin/hdc-guard-env.ts", import.meta.url).href)};
      import { Global } from "@opencode-ai/core/global";
      const hooks = await HdcGuardEnvPlugin({});
      const output = { env: ${JSON.stringify(upstream)} };
      await hooks["shell.env"]({ cwd: ${JSON.stringify(directory)}, directory: ${JSON.stringify(directory)}, sessionID: "ses_path_test" }, output);
      if (!output.env.DEVECO_CODE_HDC_ENDPOINT) throw new Error("HDC guard did not initialize");
      postMessage({ PATH: output.env.PATH, bin: Global.Path.bin });
    `)}`,
    {
      // Explicit env matches createTuiWorker: Windows keys become case-sensitive.
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path")),
        DEVECO_RUNTIME_MODE: "default",
        DEVECO_TEST_HOME: path.join(directory, "home"),
        DEVECO_STORAGE_ROOT: "",
        DEVECO_CONFIG_DIR: "",
        XDG_CONFIG_HOME: path.join(directory, "config"),
        XDG_CACHE_HOME: path.join(directory, "cache"),
        XDG_DATA_HOME: path.join(directory, "data"),
        XDG_STATE_HOME: path.join(directory, "state"),
        ...ambient,
      },
    },
  )
  try {
    return await new Promise<{ PATH: string; bin: string }>((resolve, reject) => {
      worker.onmessage = (event) => resolve(event.data)
      worker.onerror = (event) => reject(new Error(event.message))
    })
  } finally {
    await worker.terminate()
  }
}
