import { afterEach, describe, expect, test } from "bun:test"
import { Context } from "effect"
import { chmod, rm } from "fs/promises"
import path from "path"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { FilePaths } from "../../src/server/routes/instance/httpapi/groups/file"
import { InstancePaths } from "../../src/server/routes/instance/httpapi/groups/instance"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string, query?: Record<string, string>) {
  const url = new URL(`http://localhost${route}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value)
  }
  return HttpApiApp.webHandler().handler(
    new Request(url, {
      headers: {
        "x-deveco-directory": directory,
      },
    }),
    context,
  )
}

// Create a directory and remove it again, so requests address a path that is gone.
async function removedDirectory(root: string) {
  const directory = path.join(root, "removed")
  await Bun.write(path.join(directory, ".keep"), "")
  await rm(directory, { recursive: true })
  return directory
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("missing instance directory", () => {
  test("rejects endpoints that would boot location services", async () => {
    await using tmp = await tmpdir({ git: true })
    const directory = await removedDirectory(tmp.path)

    const responses = await Promise.all([
      request(FilePaths.list, directory, { path: "." }),
      request(FilePaths.findText, directory, { pattern: "a" }),
      request(InstancePaths.agent, directory),
    ])

    for (const response of responses) {
      expect(response.status).toBe(409)
      const body = await response.json()
      // A defect would have been rendered by the error layer as a ref-only body with no tag.
      expect(body).toEqual({ _tag: "DirectoryMissingError", directory, message: expect.stringContaining(directory) })
    }
  })

  test("rejects path lookups too", async () => {
    await using tmp = await tmpdir({ git: true })
    const directory = await removedDirectory(tmp.path)

    // The instance itself boots for a removed directory, so this used to succeed.
    // The guard runs before the store loads and covers every instance-scoped route.
    const response = await request(InstancePaths.path, directory)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      _tag: "DirectoryMissingError",
      directory,
      message: expect.stringContaining(directory),
    })
  })

  // Permissions are ignored when the test process runs as root.
  test.skipIf(process.getuid?.() === 0)("reports an unreadable directory as a server error", async () => {
    await using tmp = await tmpdir({ git: true })
    const parent = path.join(tmp.path, "locked")
    const directory = path.join(parent, "checkout")
    await Bun.write(path.join(directory, ".keep"), "")

    // The directory itself stats fine, so only an unreadable parent makes the check fail.
    await chmod(parent, 0o000)
    try {
      const response = await request(InstancePaths.path, directory)

      // Not a missing directory: the session is not offered a migration.
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({
        _tag: "DirectoryUnreadableError",
        directory,
        message: expect.stringContaining(directory),
      })
    } finally {
      await chmod(parent, 0o755)
    }
  })

  test.skipIf(process.getuid?.() === 0)("reports an unreadable session directory as a server error", async () => {
    await using tmp = await tmpdir({ git: true })
    const parent = path.join(tmp.path, "locked")
    const directory = path.join(parent, "checkout")
    await Bun.write(path.join(directory, ".keep"), "")

    const created = await HttpApiApp.webHandler().handler(
      new Request("http://localhost/api/session", {
        method: "POST",
        headers: { "content-type": "application/json", "x-deveco-directory": directory },
        body: JSON.stringify({ location: { directory } }),
      }),
      context,
    )
    expect(created.status).toBe(200)
    const { data: session } = (await created.json()) as { data: { id: string } }

    await chmod(parent, 0o000)
    try {
      const response = await HttpApiApp.webHandler().handler(
        new Request(`http://localhost/api/session/${session.id}`),
        context,
      )

      // Not a missing directory: the session is not offered a migration.
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({
        _tag: "DirectoryUnreadableError",
        directory,
        message: expect.stringContaining(directory),
      })
    } finally {
      await chmod(parent, 0o755)
    }
  })

  test("answers a legacy session read with a typed error once the session directory is gone", async () => {
    await using tmp = await tmpdir({ git: true })
    const directory = path.join(tmp.path, "checkout")
    await Bun.write(path.join(directory, ".keep"), "")

    const created = await HttpApiApp.webHandler().handler(
      new Request("http://localhost/api/session", {
        method: "POST",
        headers: { "content-type": "application/json", "x-deveco-directory": directory },
        body: JSON.stringify({ location: { directory } }),
      }),
      context,
    )
    expect(created.status).toBe(200)
    const { data: session } = (await created.json()) as { data: { id: string } }

    // The user path: delete the checkout, then open the session from the TUI again. This request
    // carries no directory of its own, so the route resolves the directory stored on the session.
    await rm(directory, { recursive: true })
    const response = await HttpApiApp.webHandler().handler(
      new Request(`http://localhost/session/${session.id}`),
      context,
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      _tag: "DirectoryMissingError",
      directory,
      message: expect.stringContaining(directory),
    })
  })

  test("keeps serving existing directories", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "hello.txt"), "hello")

    const [list, info, agent] = await Promise.all([
      request(FilePaths.list, tmp.path, { path: "." }),
      request(InstancePaths.path, tmp.path),
      request(InstancePaths.agent, tmp.path),
    ])

    expect(list.status).toBe(200)
    expect(await list.json()).toContainEqual(expect.objectContaining({ name: "hello.txt", type: "file" }))
    expect(info.status).toBe(200)
    expect(await info.json()).toMatchObject({ directory: tmp.path })
    expect(agent.status).toBe(200)
  })
})
