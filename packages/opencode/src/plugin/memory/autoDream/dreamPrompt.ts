/**
 * Dream Prompt - 4-phase memory consolidation prompt for Auto Dream
 * 
 * Fire-and-forget: agent must release lock and write dream state when done.
 */

import type { MemoryHeader, MemoryExpiryConfig } from "../memory/types"
import { DEFAULT_MEMORY_EXPIRY_CONFIG } from "../memory/types"

export const DREAM_CONSOLIDATION_PROMPT_BASE = `# Dream: Memory Consolidation

You are a memory consolidation agent. Your task is to organize and optimize the project's memory files.

## Phase 1 - Orient

First, understand the current memory state:
- Use memory-read to list all memories (no args shows all)
- Read existing memory files to understand themes
- Note current MEMORY.md index structure

## Phase 2 - Gather recent signal

Collect information that needs consolidation:
- Use memory-search to find overlapping topics
- Identify memories that may have drifted from current project state
- Look for contradictions between memories

## Phase 3 - Consolidate

Perform consolidation actions:
- Merge overlapping memories into unified files using memory-write
- Update outdated facts with current information
- **Delete contradicted facts — if current investigation overturns an old memory, delete the old version rather than keeping both**
- Create new memory files for emerging topics
- Remove redundant content using memory-delete

## Phase 4 - Prune and index

Cleanup and organize:
- Update MEMORY.md to reflect changes (done automatically by memory-write/delete)
- Keep index under 200 lines
- **Demote verbose entries: if an index line is over ~150 characters, shorten it — the detail belongs in the topic file, not the index**
- **Convert relative dates ('yesterday', 'last week') to absolute dates so they remain interpretable after time passes**
- Remove stale pointers
- Resolve any remaining contradictions

## CRITICAL: Final Steps (Must Complete)

After finishing all 4 phases, you MUST do these two steps:

### Step 1: Write Dream State
Write the consolidation completion state to the dream state file.
Write this JSON content to the dream state path (use \`write\` or \`patch\` whichever is available):
\`\`\`json
{"lastConsolidationAt": <current_timestamp_ms>, "sessionCount": 0, "lastSessionScanAt": <current_timestamp_ms>, "lastPid": 0}
\`\`\`
Replace \`<current_timestamp_ms>\` with the current timestamp in milliseconds (use Date.now() value).

### Step 2: Release Consolidation Lock
Release the consolidation lock by writing an empty JSON object \`{}\` to the lock file path.
Use \`write\` or \`patch\` whichever is available. This clears the lock so future consolidation triggers can proceed.

**Both steps are mandatory.** If you skip them, future consolidation will be blocked.
`

export const DREAM_SKILL_SECTIONS = `
## Skill Management (Additional Phases)

In addition to memory consolidation, also review and manage skills:

### Phase 1 (Skills)
- Use skill-list to list all skills with metadata
- Review skill descriptions and categories for relevance

### Phase 2 (Skills)
- Identify skills that haven't been used recently
- Find skills with outdated or incomplete instructions

### Phase 3 (Skills)
- Update skills with new learnings using skill-manage (action='patch')
- Merge similar skills if they cover the same workflow

### Phase 4 (Skills)
- Delete skills that are no longer relevant using skill-manage (action='delete')
- Archive skills that haven't been used in recent sessions
`

/** @deprecated Use DREAM_CONSOLIDATION_PROMPT_BASE + conditional DREAM_SKILL_SECTIONS */
export const DREAM_CONSOLIDATION_PROMPT = DREAM_CONSOLIDATION_PROMPT_BASE + DREAM_SKILL_SECTIONS

export function buildDreamPrompt(
  sessionCount: number,
  lockFilePath?: string,
  dreamStatePath?: string,
  memoryRoot?: string,
  headers?: MemoryHeader[],
  expiryConfig?: MemoryExpiryConfig,
  skillEnabled?: boolean,
): string {
  const base = buildBasePrompt(skillEnabled);
  const ctx = buildContextSection(sessionCount);
  const paths = buildPathsSection(lockFilePath, dreamStatePath, memoryRoot);
  const expiry = buildExpirySection(headers, expiryConfig ?? DEFAULT_MEMORY_EXPIRY_CONFIG, memoryRoot);
  return base + ctx + paths + expiry;
}

function buildBasePrompt(skillEnabled?: boolean): string {
  return skillEnabled
    ? DREAM_CONSOLIDATION_PROMPT_BASE + DREAM_SKILL_SECTIONS
    : DREAM_CONSOLIDATION_PROMPT_BASE;
}

function buildContextSection(sessionCount: number): string {
  if (sessionCount <= 0) { return '' }
  return `\n## Context\n\nThis consolidation runs after ${sessionCount} sessions. Prioritize recent signals and emerging patterns.\n`;
}

function buildPathsSection(lockFilePath?: string, dreamStatePath?: string, memoryRoot?: string): string {
  if (!lockFilePath && !dreamStatePath) { return '' }
  return `\n## File Paths (for final steps)\n\n- Lock file path: ${lockFilePath || '(not provided - skip lock release)'}\n- Dream state file path: ${dreamStatePath || '(not provided - skip dream state write)'}\n- Memory root: ${memoryRoot || '(not provided)'}\n`;
}

function buildExpiryAgeTable(headers: MemoryHeader[], ttlByType: Record<string, number | null>): string {
  const now = Date.now();
  return headers
    .filter(h => !h.pin)
    .map(h => {
      const daysOld = h.mtime ? Math.round((now - h.mtime) / (1000 * 60 * 60 * 24)) : Infinity;
      const ttlDays = h.ttl ?? ttlByType[h.type] ?? null;
      const status = ttlDays === null ? 'OK'
        : typeof ttlDays === 'number' && daysOld > ttlDays ? 'EXPIRED'
        : 'OK';
      const mtimeStr = h.mtime ? new Date(h.mtime).toISOString().split('T')[0] : 'unknown';
      const ageStr = daysOld === Infinity ? 'unknown' : String(daysOld);
      const ttlStr = ttlDays === null ? '∞' : String(ttlDays);
      return `| ${h.name} | ${h.type} | ${mtimeStr} | ${ageStr} | ${ttlStr} | ${status} |`;
    })
    .join('\n');
}

function buildExpirySection(
  headers: MemoryHeader[] | undefined,
  config: MemoryExpiryConfig,
  memoryRoot?: string,
): string {
  if (!config.enabled || !headers || headers.length === 0) { return '' }
  const ttlByType = config.ttlByType;
  const ageTableRows = buildExpiryAgeTable(headers, ttlByType);
  const ttlLabels: Record<string, string> = {
    user: ttlByType.user === null ? 'Never expires (∞)' : `${ttlByType.user} days`,
    feedback: `${ttlByType.feedback} days`,
    project: `${ttlByType.project} days`,
    reference: `${ttlByType.reference} days`,
  };
  return `
## Phase 4 - Expiry Rules (MUST follow these quantified rules)

### Default TTL by memory type:

| Type | Default TTL |
|------|------------|
| user | ${ttlLabels.user} |
| feedback | ${ttlLabels.feedback} |
| project | ${ttlLabels.project} |
| reference | ${ttlLabels.reference} |

### Individual overrides:
- If a memory has \`pin: true\` in frontmatter → NEVER delete it (excluded from expiry)
- If a memory has \`ttl: <N>\` in frontmatter → use that TTL (days) instead of type default

### Current memory ages:

| Name | Type | mtime | Age (days) | TTL (days) | Status |
|------|------|-------|------------|------------|---------|
${ageTableRows}

### CRITICAL: Two-Step Deletion Process

Do NOT call \`memory-delete\` for expired memories.

Instead, write a \`.pending-expiry.json\` file to the memory root path:
${memoryRoot || '(not provided)'}/.pending-expiry.json

The file must contain this exact JSON structure:
{
  "pendingDeletions": [
    {"name": "<memory_name>", "type": "<type>", "mtime": <timestamp>, "ageDays": <days>, "ttlDays": <ttl_or_null>, "reason": "expired"}
  ],
  "generatedAt": <current_timestamp_ms>,
  "dreamSessionID": "<your_session_id>"
}

Only include memories whose Status is "EXPIRED" in the table above.
Exclude memories with \`pin: true\` or custom \`ttl\` override that hasn't expired yet.
This marks memories as pending deletion — the user will confirm deletion in their next conversation.
`;
}