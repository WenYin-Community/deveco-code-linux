import path from "node:path"
import { Flock } from "@opencode-ai/core/util/flock"
import * as Filesystem from "@/util/filesystem"

type Store = {
  global: string[]
  projects: Record<string, string[]>
}

export type Scope = "global" | "project"

const FILE = "skill-preferences.json"

function isEnoent(error: unknown): error is { code: "ENOENT" } {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function normalize(value: unknown): Store {
  if (typeof value !== "object" || value === null) return { global: [], projects: {} }
  const record = value as Record<string, unknown>
  // Migrate the short-lived name-only format conservatively as global state.
  if (Array.isArray(record.disabled)) return { global: names(record.disabled), projects: {} }
  const projects =
    typeof record.projects === "object" && record.projects !== null
      ? Object.fromEntries(
          Object.entries(record.projects)
            .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
            .map(([projectID, disabled]) => [projectID, names(disabled)]),
        )
      : {}
  return {
    global: Array.isArray(record.global) ? names(record.global) : [],
    projects,
  }
}

function names(value: unknown[]): string[] {
  return Array.from(new Set(value.filter((item): item is string => typeof item === "string"))).toSorted()
}

async function read(file: string): Promise<Store> {
  try {
    return normalize(await Filesystem.readJson(file))
  } catch (error) {
    if (isEnoent(error)) return { global: [], projects: {} }
    throw error
  }
}

export async function disabled(
  configDir: string,
  projectID: string,
): Promise<{ global: Set<string>; project: Set<string> }> {
  const file = path.join(configDir, FILE)
  return Flock.withLock(`skill-preferences:${file}`, async () => {
    const store = await read(file)
    return {
      global: new Set(store.global),
      project: new Set(store.projects[projectID] ?? []),
    }
  })
}

export async function setEnabled(
  configDir: string,
  projectID: string,
  scope: Scope,
  name: string,
  enabled: boolean,
): Promise<void> {
  const file = path.join(configDir, FILE)
  await Flock.withLock(`skill-preferences:${file}`, async () => {
    const store = await read(file)
    const next = new Set(scope === "global" ? store.global : (store.projects[projectID] ?? []))
    if (enabled) next.delete(name)
    else next.add(name)
    if (scope === "global") store.global = Array.from(next).toSorted()
    else if (next.size) store.projects[projectID] = Array.from(next).toSorted()
    else
      store.projects = Object.fromEntries(
        Object.entries(store.projects).filter(([key]) => key !== projectID),
      )
    await Filesystem.writeJson(file, store, 0o600)
  })
}

export * as SkillPreference from "./preference"
