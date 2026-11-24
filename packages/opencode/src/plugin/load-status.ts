import type { PluginEntryFailureStage, PluginEntryLoadStatus } from "./analytics/types"

/**
 * What the plugin layer learned about one declared plugin of one directory instance.
 *
 * The loader reports while it loads; the analytics plugin reads afterwards, from its `config` hook,
 * which runs after the server plugins have been applied. Recording is the only way analytics can
 * tell "loaded" from "failed at install" without importing or re-running user plugin code.
 */
export interface PluginLoadRecord {
  loadStatus: PluginEntryLoadStatus
  failureStage: PluginEntryFailureStage
}

// Keyed by the instance directory because one process serves many projects and the same spec can
// resolve differently for each of them (user config versus a project's .deveco config). Specs are
// stored exactly as the config writes them: the loader reports by `origin.spec` and analytics looks
// up that same string, so normalizing here would report version-pinned plugins as never loaded.
const recordsByDirectory = new Map<string, Map<string, PluginLoadRecord>>()

/** Remembers the last status reported for a spec; a later record replaces it. */
export function record(directory: string, spec: string, entry: PluginLoadRecord): void {
  const records = recordsByDirectory.get(directory)
  if (!records) {
    recordsByDirectory.set(directory, new Map([[spec, entry]]))
    return
  }
  records.set(spec, entry)
}

/** The record for a spec, or undefined when the plugin layer never reported it. */
export function lookup(directory: string, spec: string): PluginLoadRecord | undefined {
  return recordsByDirectory.get(directory)?.get(spec)
}

/** A copy of everything recorded for one directory, safe for a consumer to walk and edit. */
export function snapshot(directory: string): Record<string, PluginLoadRecord> {
  const records = recordsByDirectory.get(directory)
  if (!records) return {}
  return Object.fromEntries(records.entries())
}

/** Forgets a directory. Hooked to the instance disposer so a long-lived server does not grow. */
export function clear(directory: string): void {
  recordsByDirectory.delete(directory)
}

export * as PluginLoadStatus from "./load-status"
