import { afterEach, describe, expect, test } from "bun:test"
import { Context } from "effect"
import path from "path"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetServeDirectory } from "@opencode-ai/server/groups/location"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string) {
  const url = new URL(`http://localhost${route}`)
  return HttpApiApp.webHandler().handler(
    new Request(url, {
      headers: {
        "x-deveco-directory": directory,
      },
    }),
    context,
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("location[directory] guard", () => {
  const originalServeCwd = process.env.DEVECO_SERVE_CWD

  test("allows the serve root directory", async () => {
    await using tmp = await tmpdir({ git: true })
    process.env.DEVECO_SERVE_CWD = tmp.path
    resetServeDirectory()

    const response = await request("/api/location", tmp.path)
    expect(response.status).toBe(200)

    process.env.DEVECO_SERVE_CWD = originalServeCwd
    resetServeDirectory()
  })

  test("allows a subdirectory of the serve root", async () => {
    await using tmp = await tmpdir({ git: true })
    process.env.DEVECO_SERVE_CWD = tmp.path
    resetServeDirectory()
    const sub = path.join(tmp.path, "packages", "app")
    await Bun.write(path.join(sub, "package.json"), "{}")

    const response = await request("/api/location", sub)
    expect(response.status).toBe(200)

    process.env.DEVECO_SERVE_CWD = originalServeCwd
    resetServeDirectory()
  })

  test("rejects a parent directory with 403 ForbiddenError", async () => {
    await using tmp = await tmpdir({ git: true })
    process.env.DEVECO_SERVE_CWD = path.join(tmp.path, "sub")
    resetServeDirectory()

    const response = await request("/api/location", tmp.path)
    expect(response.status).toBe(403)
    const body = (await response.json()) as { _tag: string; message: string }
    expect(body._tag).toBe("ForbiddenError")
    expect(body.message).toContain("location[directory] must be within the serve directory")

    process.env.DEVECO_SERVE_CWD = originalServeCwd
    resetServeDirectory()
  })

  test("rejects an unrelated directory with 403 ForbiddenError", async () => {
    await using tmp = await tmpdir({ git: true })
    process.env.DEVECO_SERVE_CWD = tmp.path
    resetServeDirectory()

    const response = await request("/api/location", "/etc")
    expect(response.status).toBe(403)
    const body = (await response.json()) as { _tag: string; message: string }
    expect(body._tag).toBe("ForbiddenError")

    process.env.DEVECO_SERVE_CWD = originalServeCwd
    resetServeDirectory()
  })

  test("rejects a prefix-collision directory with 403", async () => {
    await using tmp = await tmpdir({ git: true })
    process.env.DEVECO_SERVE_CWD = tmp.path
    resetServeDirectory()
    const collision = tmp.path + "-suffix"

    const response = await request("/api/location", collision)
    expect(response.status).toBe(403)

    process.env.DEVECO_SERVE_CWD = originalServeCwd
    resetServeDirectory()
  })

  test("defaults to serve root when no location[directory] is provided", async () => {
    await using tmp = await tmpdir({ git: true })
    process.env.DEVECO_SERVE_CWD = tmp.path
    resetServeDirectory()

    const url = new URL("http://localhost/api/location")
    const response = await HttpApiApp.webHandler().handler(new Request(url), context)
    expect(response.status).toBe(200)

    process.env.DEVECO_SERVE_CWD = originalServeCwd
    resetServeDirectory()
  })

  test("allows reading a file within the serve root", async () => {
    await using tmp = await tmpdir({ git: true })
    process.env.DEVECO_SERVE_CWD = tmp.path
    resetServeDirectory()
    await Bun.write(path.join(tmp.path, "hello.txt"), "hello")

    const response = await request("/api/fs/read/hello.txt", tmp.path)
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toBe("hello")

    process.env.DEVECO_SERVE_CWD = originalServeCwd
    resetServeDirectory()
  })

  test("blocks file read when location[directory] is outside the serve root", async () => {
    await using tmp = await tmpdir({ git: true })
    process.env.DEVECO_SERVE_CWD = tmp.path
    resetServeDirectory()

    const response = await request("/api/fs/read/passwd", "/etc")
    expect(response.status).toBe(403)

    process.env.DEVECO_SERVE_CWD = originalServeCwd
    resetServeDirectory()
  })
})
