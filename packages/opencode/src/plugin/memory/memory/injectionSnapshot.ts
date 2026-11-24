/**
 * Injection Snapshot Module
 * Freezes the memory/skill system-prompt blocks per session so the injected
 * prefix stays byte-identical for every LLM request within a session. This
 * keeps the provider prompt cache valid: the snapshot is rendered once (first
 * request of a session / process start) and reused until the session ends.
 */
import { SKILLS_GUIDANCE, SLASH_COMMANDS_GUIDANCE } from "../skills/prompts"
import { createLogger } from "../util/logger"

const log = createLogger('[InjectionSnapshot]')

/**
 * Bounded per-session snapshot store. FIFO-evicts the oldest entry once the
 * cap is reached; entries are also dropped on session.deleted events.
 */
export class SessionInjectionSnapshotCache {
    private snapshots = new Map<string, string[]>()

    constructor(private maxEntries = 64) {}

    get(sessionID: string): string[] | undefined {
        return this.snapshots.get(sessionID)
    }

    set(sessionID: string, blocks: string[]): void {
        // Re-insert so a refresh moves the entry to the back of the FIFO order
        this.snapshots.delete(sessionID)
        this.snapshots.set(sessionID, blocks)
        while (this.snapshots.size > this.maxEntries) {
            const oldest = this.snapshots.keys().next().value
            if (oldest === undefined) break
            this.snapshots.delete(oldest)
        }
    }

    delete(sessionID: string): void {
        this.snapshots.delete(sessionID)
    }

    /** Drop every entry the predicate rejects; used on hot reload to keep fork snapshots. */
    prune(keep: (sessionID: string) => boolean): void {
        for (const sessionID of this.snapshots.keys()) {
            if (!keep(sessionID)) this.snapshots.delete(sessionID)
        }
    }

    clear(): void {
        this.snapshots.clear()
    }

    get size(): number {
        return this.snapshots.size
    }
}

export interface InjectionBlockInputs {
    injection: {
        injectIndexOnly(): Promise<{ systemPrompt?: string }>
        inject(query?: string): Promise<{ systemPrompt?: string }>
    }
    skillInjection: {
        inject(): Promise<{ systemPrompt?: string }>
    }
    opts: {
        truncationEnabled: boolean
        skillsEnabled: boolean
        slashCommandsEnabled: boolean
        subMemoryRecall: boolean
        subSkillReviewTrigger: boolean
        isSubNow: boolean
    }
}

/**
 * Compute the exact block sequence the plugin pushes into output.system —
 * memory block (index-only or legacy full injection), skill block + guidance,
 * slash-command guidance. Returns the blocks instead of pushing them so the
 * result can be snapshotted and unit-tested in isolation.
 *
 * hadError is true when any block's storage read threw; callers must not
 * cache a degraded render (a transient disk error would otherwise freeze a
 * memory-less prompt for the whole session).
 */
export async function computeInjectionBlocks(inputs: InjectionBlockInputs): Promise<{ blocks: string[]; hadError: boolean }> {
    const { injection, skillInjection, opts } = inputs
    const blocks: string[] = []
    let hadError = false

    if (!opts.isSubNow || opts.subMemoryRecall) {
        try {
            const result = opts.truncationEnabled
                ? await injection.injectIndexOnly()
                : await injection.inject()
            if (result.systemPrompt) { blocks.push(result.systemPrompt) }
        } catch (e) {
            hadError = true
            log.error('Memory injection failed:', e instanceof Error ? e.message : String(e))
        }
    }

    if (opts.skillsEnabled && (!opts.isSubNow || opts.subSkillReviewTrigger)) {
        try {
            const skillResult = await skillInjection.inject()
            if (skillResult.systemPrompt) { blocks.push(skillResult.systemPrompt) }
            blocks.push(SKILLS_GUIDANCE)
        } catch (e) {
            hadError = true
            log.error('Skill injection failed:', e instanceof Error ? e.message : String(e))
        }
    }

    if (opts.slashCommandsEnabled) { blocks.push(SLASH_COMMANDS_GUIDANCE) }

    return { blocks, hadError }
}
