/**
 * Leaf module shared by the Snip engine (`snip.ts`) and the model projection
 * (`message-v2.ts`). Deliberately has NO imports from the session package so
 * that `message-v2 ← snip-shared → snip → compaction → message-v2` does not
 * form a circular import. Pure constants and a pure function only.
 */

/**
 * Generic placeholder substituted for snipped (History Snip Compact)
 * Read/Grep/Glob tool results when projecting to the model. Preserves
 * tool_use/tool_result pairing; the original output stays in storage for UI
 * replay.
 */
 export const SNIP_PLACEHOLDER = '该轮主要是前期探索搜索，最终信息已在后续文本中保留';

 /**
  * System-prompt note explaining the `[turn_XXXXXX]` marker appended to user
  * messages. Injected alongside `injectMessageIds` so the model understands the
  * tag is a conversation-turn reference, NOT a device/emulator/session ID.
  */
 export const TURN_TAG_SYSTEM_NOTE = [
   "Conversation turns are tagged: each user message ends with a marker of the form [turn_xxxxxx] (for example [turn_a1b2c3]).",
   "This is a conversation-turn reference injected by the system's history-compression feature so individual turns can be identified.",
   "It is NOT a device ID, emulator ID, serial number, or any other kind of system identifier.",
   "Do not interpret it as a device or emulator identifier, do not pass it to device-related tools (such as start_app), and do not echo it back in your responses.",
 ].join('\n');

/**
 * Derive a short, deterministic 6-char base36 turn id from a message id.
 * Used to tag user queries ([turn_XXXXXX]) in the model projection and to record
 * snipped turn ids in the boundary marker. Pure — same input always yields the
 * same output, so the tag in a user message matches the id recorded in a snip
 * boundary.
 */
export function deriveShortId(messageID: string): string {
  // FNV-1a inspired deterministic hash over the full message id string.
  let hash = 0x811c9dc5
  for (let i = 0; i < messageID.length; i++) {
    hash ^= messageID.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  // Force unsigned and render in base36, take 6 chars.
  return (hash >>> 0).toString(36).padStart(6, '0').slice(0, 6);
}
