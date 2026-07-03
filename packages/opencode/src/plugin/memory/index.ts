import type { Plugin } from "@opencode-ai/plugin"
import { initLogger, logger } from './util/logger';
import { MemoryStorage } from './memory/storage';
import { normalizeProjectPath } from './util/path';
import { MemoryInjection } from './memory/injection';
import { EnhancedMemoryRetrieval } from './memory/enhanced-retrieval';
import { DEFAULT_MEMORY_CONFIG, z, DEFAULT_AUTO_DREAM_CONFIG, DEFAULT_EXTRACTION_CONFIG, DEFAULT_TRUNCATION_CONFIG, DEFAULT_SKILL_CONFIG, DEFAULT_MEMORY_RECALL_CONFIG, DEFAULT_SEMANTIC_SELECTION_CONFIG, DEFAULT_MEMORY_EXPIRY_CONFIG } from './memory/types';
// Auto Dream imports
import { initAutoDream, executeAutoDream, handleChatMessageTrigger, checkAllGates, isConsolidationInProgress, markDreamDone } from './autoDream/autoDream';
import { isForkedSession, unregisterForkSession, getForkSessionAgent } from './util/forkManager';
import { isSubagentSession, isBackgroundSession, detectAndRegisterSubagent } from './util/subagentManager';


// Auto Memory Extraction imports
import { initAutoMemoryExtraction, getExtractionRunner, } from './memory/extractionRunner';
import { releaseExtractionLock } from './memory/extractionLock';
import { processToolCallForSkill, incrementTurnCounter, markExtractionCompleted, resetSkillCounter as resetExtractionSkillCounter, getThresholdState, updateThresholdState } from './memory/extractionThreshold';
// Skills imports
import { SkillStorage, SkillInjection, SKILLS_GUIDANCE, SLASH_COMMANDS_GUIDANCE, } from './skills';
import { checkSkillThreshold, incrementSkillCounter, resetSkillCounter, DEFAULT_SKILL_TRIGGER_STATE, } from './skills/trigger';
import { spawnSkillReviewAgent, isSkillReviewInProgress, releaseSkillReviewLock, getSkillReviewLockPath } from './skills/reviewAgent';
import { skillManageTool, skillListTool, skillViewTool } from './skills/tools';
// Slash Commands imports
import { parseSlashCommand, isSlashCommand, getCommandRegistry, } from './slashCommands';

const DEFAULT_SUBAGENT_HOOKS_CONFIG = {
    autoMemoryExtraction: false,
    autoDreamGate: false,
    skillReviewTrigger: false,
    memoryRecall: false,
    visibleRecall: false,
    visibleWrite: false,
};

const DEFAULT_PLUGIN_CONFIG = {
    autoMemory: { enabled: true },
    autoDream: { enabled: true },
    extraction: { enabled: true },
    skills: { enabled: false },
    slashCommands: { enabled: true },
    logLevel: 'error',
    memoryRecall: { enabled: true, visibleRecall: true, visibleWrite: true, minRelevanceScore: 0.3, maxInjectChars: 200 },
    semanticSelection: { enabled: true },
    subagentHooks: DEFAULT_SUBAGENT_HOOKS_CONFIG,
};

const stateMap = new Map();
const pendingRecallMap = new Map();
const pendingWriteMap = new Map();
const recalledUserMsgIds = new Set<string>();

function setPendingWrite(sessionID: string, text: string) {
    const existing = pendingWriteMap.get(sessionID);
    if (existing) {
        pendingWriteMap.set(sessionID, existing + ', ' + text);
    } else {
        pendingWriteMap.set(sessionID, text);
    }
}

let pendingExpiryToastShown = false;

async function getPendingExpiryNotice(state: any): Promise<string | null> {
    if (!state.expiryConfig?.enabled) return null;
    const pending = await state.storage.readPendingExpiry();
    if (!pending || pending.pendingDeletions.length === 0) return null;
    const items = pending.pendingDeletions.map((d: any) => `- **${d.name}** (${d.type}, age: ${d.ageDays}d, TTL: ${d.ttlDays ?? '∞'})`).join('\n');
    return `\n\n---\n⚠️ **Pending expiry**: ${pending.pendingDeletions.length} memories marked for deletion:\n${items}\n\n**You MUST immediately use the \`question\` tool to present the user with interactive approve/reject choices.** Do not just describe the expiry passively — ask the user to decide: "确认删除" (call \`dream-approve\`) or "保留" (call \`dream-reject\`).`;
}

async function showPendingExpiryToast(state: any): Promise<void> {
    if (pendingExpiryToastShown || !state.client) return;
    const pending = await state.storage.readPendingExpiry();
    if (!pending || pending.pendingDeletions.length === 0) return;
    pendingExpiryToastShown = true;
    try {
        await state.client.tui.showToast({
            body: {
                title: '⚠️ Pending expiry',
                message: `${pending.pendingDeletions.length} memories marked for deletion. Use /dream-approve or /dream-reject.`,
                variant: 'warning',
                duration: 6000,
            },
        });
    } catch (e) { logger.error('[PendingExpiry]', 'toast failed:', e); }
}

function mergeConfig(pluginConfig: any) {
    const legacyEnabled = pluginConfig.enabled;
    const autoMemoryConfig = {
        ...DEFAULT_MEMORY_CONFIG,
        ...pluginConfig.autoMemory,
        enabled: pluginConfig.autoMemory?.enabled ?? legacyEnabled ?? DEFAULT_MEMORY_CONFIG.enabled,
        maxMemoryFiles: pluginConfig.maxMemoryFiles ?? pluginConfig.autoMemory?.maxMemoryFiles ?? DEFAULT_MEMORY_CONFIG.maxMemoryFiles,
        maxEntrypointLines: pluginConfig.maxEntrypointLines ?? pluginConfig.autoMemory?.maxEntrypointLines ?? DEFAULT_MEMORY_CONFIG.maxEntrypointLines,
        maxEntrypointBytes: pluginConfig.maxEntrypointBytes ?? pluginConfig.autoMemory?.maxEntrypointBytes ?? DEFAULT_MEMORY_CONFIG.maxEntrypointBytes,
        storageMode: pluginConfig.storageMode ?? pluginConfig.autoMemory?.storageMode ?? DEFAULT_MEMORY_CONFIG.storageMode,
        customMemoryDir: pluginConfig.customMemoryDir ?? pluginConfig.autoMemory?.customMemoryDir,
        minSessionsBeforeConsolidation: pluginConfig.minSessionsBeforeConsolidation ?? pluginConfig.autoMemory?.minSessionsBeforeConsolidation ?? DEFAULT_MEMORY_CONFIG.minSessionsBeforeConsolidation,
        minHoursBetweenConsolidation: pluginConfig.minHoursBetweenConsolidation ?? pluginConfig.autoMemory?.minHoursBetweenConsolidation ?? DEFAULT_MEMORY_CONFIG.minHoursBetweenConsolidation,
        truncation: {
            ...DEFAULT_TRUNCATION_CONFIG,
            ...pluginConfig.autoMemory?.truncation,
        },
    };
    const autoDreamConfig = {
        ...DEFAULT_AUTO_DREAM_CONFIG,
        ...pluginConfig.autoDream,
        enabled: pluginConfig.autoDream?.enabled ?? DEFAULT_AUTO_DREAM_CONFIG.enabled,
    };
    const extractionConfig = {
        ...DEFAULT_EXTRACTION_CONFIG,
        ...pluginConfig.extraction,
        enabled: pluginConfig.extraction?.enabled ?? DEFAULT_EXTRACTION_CONFIG.enabled,
        syncMode: pluginConfig.extraction?.syncMode ?? DEFAULT_EXTRACTION_CONFIG.syncMode,
        syncWaitTimeoutMs: pluginConfig.extraction?.syncWaitTimeoutMs ?? DEFAULT_EXTRACTION_CONFIG.syncWaitTimeoutMs,
    };
const skillConfig = {
        ...DEFAULT_SKILL_CONFIG,
        ...pluginConfig.skills,
        enabled: pluginConfig.skills?.enabled ?? DEFAULT_SKILL_CONFIG.enabled,
    };
    const memoryRecallConfig = {
        ...DEFAULT_MEMORY_RECALL_CONFIG,
        ...pluginConfig.memoryRecall,
        enabled: pluginConfig.memoryRecall?.enabled ?? DEFAULT_MEMORY_RECALL_CONFIG.enabled,
        visibleRecall: pluginConfig.memoryRecall?.visibleRecall ?? DEFAULT_MEMORY_RECALL_CONFIG.visibleRecall,
        visibleWrite: pluginConfig.memoryRecall?.visibleWrite ?? DEFAULT_MEMORY_RECALL_CONFIG.visibleWrite,
        minRelevanceScore: pluginConfig.memoryRecall?.minRelevanceScore ?? DEFAULT_MEMORY_RECALL_CONFIG.minRelevanceScore,
        maxInjectChars: pluginConfig.memoryRecall?.maxInjectChars ?? DEFAULT_MEMORY_RECALL_CONFIG.maxInjectChars,
    };
    const semanticSelectionConfig = {
        ...DEFAULT_SEMANTIC_SELECTION_CONFIG,
        ...pluginConfig.semanticSelection,
        enabled: pluginConfig.semanticSelection?.enabled ?? DEFAULT_SEMANTIC_SELECTION_CONFIG.enabled,
    };
    const subagentHooksConfig = {
        ...DEFAULT_SUBAGENT_HOOKS_CONFIG,
        ...pluginConfig.subagentHooks,
    };
    const expiryConfig = {
        ...DEFAULT_MEMORY_EXPIRY_CONFIG,
        ...pluginConfig.autoMemory?.expiry,
    };
    return {
        autoMemory: autoMemoryConfig,
        autoDream: autoDreamConfig,
        extraction: extractionConfig,
        skills: skillConfig,
        memoryRecall: memoryRecallConfig,
        semanticSelection: semanticSelectionConfig,
        subagentHooks: subagentHooksConfig,
        expiry: expiryConfig,
    };
}

async function getState(projectID: string, directory: string, pluginConfig: any = {}, client: any) {
    let state = stateMap.get(projectID);
    if (!state) {
        initLogger(pluginConfig.logLevel || 'error');
        const { autoMemory: fullConfig, autoDream: autoDreamConfig, extraction: extractionConfig, skills: skillConfig, memoryRecall: memoryRecallConfig, semanticSelection: semanticSelectionConfig, subagentHooks: subagentHooksConfig, expiry: expiryConfig } = mergeConfig(pluginConfig);
        const storage = new MemoryStorage(projectID, directory, fullConfig);
        await storage.init();
        logger.info('[PluginInit]', 'projectID:', projectID, 'memoryPath:', storage.getMemoryPath());
        const skillStorage = new SkillStorage();
        await skillStorage.init();
const skillInjection = new SkillInjection(skillStorage, skillConfig);
        const slashCommandsEnabled = pluginConfig.slashCommands?.enabled ?? true;
        const commandRegistry = getCommandRegistry();
        const slashCommandTargetMap: Record<string, string> = {
            'dream': 'dream-trigger',
            'dream-force': 'dream-trigger',
            'dream-approve': 'dream-approve',
            'dream-reject': 'dream-reject',
            'auto-skill': 'skill-review-trigger',
        };
        if (slashCommandsEnabled && skillStorage) {
            try {
                const skillsWithCommand = await skillStorage.getSkillsWithSlashCommand();
                for (const s of skillsWithCommand) {
                    const targetTool = slashCommandTargetMap[s.slashCommand] || 'dream-trigger';
                    commandRegistry.register({
                        name: s.slashCommand,
                        targetTool,
                        skillName: s.skillName,
                        args: targetTool === 'dream-trigger' ? ['force'] : [],
                    });
                }
            }
            catch { }
        }
        state = {
            storage,
            retrieval: new EnhancedMemoryRetrieval(storage, fullConfig, memoryRecallConfig, semanticSelectionConfig, client),
            injection: new MemoryInjection(storage, fullConfig),
            config: fullConfig,
            autoDreamConfig,
            extractionConfig,
            skillStorage,
            skillInjection,
            skillConfig,
            skillTriggerState: DEFAULT_SKILL_TRIGGER_STATE,
            slashCommandsEnabled,
            commandRegistry,
            client,
            memoryRecallConfig,
            semanticSelectionConfig,
            subagentHooksConfig,
            expiryConfig,
        };
        if (client) {
            initAutoDream(client, storage, autoDreamConfig);
        }
        if (client && fullConfig.enabled) {
            initAutoMemoryExtraction(client, storage, extractionConfig, undefined, skillStorage, skillConfig);
        }
        stateMap.set(projectID, state);
    }
    return state;
}

export const MemoryPlugin: Plugin = async (input: any, options: any = {}) => {
    const rawDirectory = input.directory || 'default';
    const projectID = normalizeProjectPath(rawDirectory);
    const directory = input.directory || '';
    const client = input.client;
    logger.info('[PluginInit]', 'rawDirectory:', rawDirectory, 'projectID:', projectID, 'normalized:', projectID !== rawDirectory);
    const slashCommandsEnabled = options.slashCommands?.enabled ?? true;
    const state = await getState(projectID, directory, options, client);

    const hooks = {
        dispose: async () => {
            stateMap.clear();
            pendingRecallMap.clear();
            pendingWriteMap.clear();
            recalledUserMsgIds.clear();
        },
'permission.ask': async (input: any, output: any) => {
            // NOTE: This hook is ineffective for PermissionNext flow (used by session/prompt.ts).
            // PermissionNext.ask() does NOT trigger plugin hooks — it uses its own rule evaluation.
            // This hook only works for the legacy Permission system. Keeping it for future compatibility.
            const sessionID = input.sessionID || '';
            const permission = input.permission || '';
            const pattern = input.pattern || '';
            logger.info('[PermissionAsk]', 'sessionID:', sessionID, 'permission:', permission, 'pattern:', pattern);
            
            if (isForkedSession(sessionID)) {
                const alwaysSafe = [
                    'read', 'grep', 'glob',
                    'memory-read', 'memory-write', 'memory-search', 'memory-delete',
                    'skill-list', 'skill-view', 'skill-manage',
                    'external_directory',
                ];
                if (alwaysSafe.includes(permission)) {
                    output.status = 'allow';
                    logger.info('[PermissionAsk]', 'Auto-allowed (forked session):', permission);
                    return;
                }
if (permission === 'edit') {
                    const lockFiles = ['.extraction-lock', '.consolidate-lock', '.skill-review-lock', '.auto-dream-state.json', '.pending-expiry.json'];
                    const isLockFile = lockFiles.some(lock => pattern.endsWith(lock) || pattern.includes(lock));
                    if (isLockFile) {
                        output.status = 'allow';
                        logger.info('[PermissionAsk]', 'Auto-allowed edit (lock file):', pattern);
                    } else {
                        output.status = 'deny';
                        logger.info('[PermissionAsk]', 'Denied edit (non-lock file):', pattern);
                    }
                    return;
                }
                output.status = 'deny';
                logger.info('[PermissionAsk]', 'Denied (forked session):', permission);
                return;
            }
            
            // Fallback: auto-allow external_directory for ANY session when pattern matches memoryRoot
            // This handles cases where forked session's permission.ask uses parent sessionID
            if (permission === 'external_directory') {
                const memoryRoot = state.storage.getMemoryPath().replace(/\\/g, '/');
                const normalizedPattern = pattern.replace(/\\/g, '/');
                if (normalizedPattern.startsWith(memoryRoot) || normalizedPattern.includes(memoryRoot)) {
                    output.status = 'allow';
                    logger.info('[PermissionAsk]', 'Auto-allowed external_directory (fallback):', pattern, 'memoryRoot:', memoryRoot);
                    return;
                }
            }
        },
event: async ({ event }: any) => {
            if (event.type === 'session.idle') {
                const sid = event.properties?.sessionID || '';
                if (!sid) return;
                if (isForkedSession(sid)) {
                    // Forked agent finished — clean up its locks/state so they don't linger.
                    const agentType = getForkSessionAgent(sid);
                    const memRoot = state.storage.getMemoryPath();
                    if (agentType === 'extraction') {
                        try { await releaseExtractionLock(memRoot); }
                        catch (e: any) { logger.warn('[SessionIdle]', 'extraction lock release failed:', e?.message || e); }
                        updateThresholdState(markExtractionCompleted(getThresholdState()));
                        logger.info('[SessionIdle]', 'Forked extraction done — lock released, threshold reset:', sid);
                    } else if (agentType === 'dream') {
                        await markDreamDone(memRoot);
                        logger.info('[SessionIdle]', 'Forked dream done — consolidation lock/flag reset:', sid);
                    } else if (agentType === 'skill-review') {
                        try { await releaseSkillReviewLock(getSkillReviewLockPath(memRoot)); }
                        catch (e: any) { logger.warn('[SessionIdle]', 'skill-review lock release failed:', e?.message || e); }
                        updateThresholdState(resetExtractionSkillCounter(getThresholdState()));
                        logger.info('[SessionIdle]', 'Forked skill-review done — lock released, skill counter reset:', sid);
                    } else {
                        logger.warn('[SessionIdle]', 'Forked session with unknown/missing agent type:', agentType || '(none)', sid);
                    }
                    unregisterForkSession(sid);
                    return;
                }
                logger.info('[SessionIdle]', 'Session idle event:', sid);
                const isSub = isSubagentSession(sid);
                if (isSub) {
                    if (!state.subagentHooksConfig.autoMemoryExtraction) return;
                }
                // Count this user turn toward the extraction throttle (subagent idles don't count).
                if (!isSub) {
                    updateThresholdState(incrementTurnCounter(getThresholdState()));
                }
                if (state.config.enabled) {
                    const extractionRunner = getExtractionRunner();
                    if (extractionRunner) {
                        void extractionRunner({
                            sessionID: sid,
                            projectID: projectID,
                            memoryRoot: state.storage.getMemoryPath(),
                            projectDirectory: directory,
                            storage: state.storage,
                        });
                        logger.info('[SessionIdle]', 'Async extraction triggered via session.idle for:', sid);
                    }
                }
            }
        },
'experimental.chat.system.transform': async (_input: any, output: any) => {
            if (!state.config.enabled)
                return;
            const sid = _input.sessionID || '';
            if (isForkedSession(sid)) return;
            const isSub = isSubagentSession(sid);
            if (isSub) {
                const subHooks = state.subagentHooksConfig;
                if (!subHooks.memoryRecall && !subHooks.skillReviewTrigger && !subHooks.autoMemoryExtraction) return;
            } else {
                await detectAndRegisterSubagent(sid, client);
                if (isSubagentSession(sid)) {
                    const subHooks = state.subagentHooksConfig;
                    if (!subHooks.memoryRecall && !subHooks.skillReviewTrigger && !subHooks.autoMemoryExtraction) return;
                }
            }
            const isSubNow = isSubagentSession(sid);
 try {
                if (!isSubNow || state.subagentHooksConfig.memoryRecall) {
                    const result = state.config.truncation?.enabled !== false
                        ? await state.injection.injectIndexOnly()
                        : await state.injection.inject();
                    if (result.systemPrompt) {
                        output.system.push(result.systemPrompt);
                    }
                }
            }
            catch { }
            if (state.skillConfig.enabled && (!isSubNow || state.subagentHooksConfig.skillReviewTrigger)) {
                try {
                    const skillResult = await state.skillInjection.inject();
                    if (skillResult.systemPrompt) {
                        output.system.push(skillResult.systemPrompt);
                    }
                    output.system.push(SKILLS_GUIDANCE);
                }
                catch { }
            }
            if (state.slashCommandsEnabled) {
                output.system.push(SLASH_COMMANDS_GUIDANCE);
            }
        },
        'experimental.session.compacting': async (_input: any, output: any) => {
            if (!state.config.enabled)
                return;
            const sid = _input.sessionID || '';
            if (isForkedSession(sid)) return;
            const isSub = isSubagentSession(sid);
            if (isSub) {
                const subHooks = state.subagentHooksConfig;
                if (!subHooks.memoryRecall) return;
            } else {
                await detectAndRegisterSubagent(sid, client);
                if (isSubagentSession(sid)) {
                    const subHooks = state.subagentHooksConfig;
                    if (!subHooks.memoryRecall) return;
                }
            }
            try {
                const context = await state.injection.getCompactionContext();
                if (context) {
                    output.context.push(context);
                }
            }
            catch { }
        },
'experimental.chat.messages.transform': async (_input: any, output: any) => {
            if (!state.memoryRecallConfig.enabled) { logger.debug('[Recall]', 'memoryRecall disabled, skip'); return; }
            try {
                const messages = output.messages;
                if (!messages || messages.length === 0) { logger.debug('[Recall]', 'no messages, skip'); return; }

                const sid = (messages[0]?.info?.sessionID || messages.findLast((m: any) => m.info?.role === 'user')?.info?.sessionID) || 'default';
                if (isForkedSession(sid)) { logger.debug('[Recall]', 'forked session, skip'); return; }
                if (isSubagentSession(sid) && !state.subagentHooksConfig.memoryRecall) { logger.debug('[Recall]', 'subagent without memoryRecall hook, skip'); return; }
                if (sid && !isSubagentSession(sid)) {
                    await detectAndRegisterSubagent(sid, client);
                    if (isSubagentSession(sid) && !state.subagentHooksConfig.memoryRecall) { logger.debug('[Recall]', 'became subagent without memoryRecall hook, skip'); return; }
                }

                const lastUserMsg = messages.findLast((m: any) => m.info?.role === 'user');
                if (!lastUserMsg) { logger.debug('[Recall]', 'no user message found, skip'); return; }

                const userMsgId = lastUserMsg.info?.id;
                if (userMsgId && recalledUserMsgIds.has(userMsgId)) {
                    logger.info('[Recall]', 'same turn already recalled for userMsg', userMsgId, ', skip (reuse first)');
                    return;
                }

                const userText = (lastUserMsg.parts || [])
                    .filter((p: any) => p.type === 'text' && !p.synthetic)
                    .map((p: any) => p.text || '')
                    .join(' ');
                if (!userText.trim()) { logger.debug('[Recall]', 'empty user text, skip'); return; }

                logger.info('[Recall]', 'query:', userText.slice(0, 100));

const alreadyInjected = new Set<string>();
                 for (const part of (lastUserMsg.parts || [])) {
                     if (part.synthetic && part.type === 'text' && part.text) {
                         const names = part.text.match(/### (\S+) \(/g);
                         if (names) {
                             names.forEach((n: string) => {
                                 const name = n.replace('### ', '').replace(' (', '');
                                 alreadyInjected.add(name);
                             });
                         }
                     }
                 }
                  if (alreadyInjected.size > 0) {
                    logger.info('[Recall]', 'recall already injected for this user message, skipping findRelevant');
                    return;
                }

                const relevant = await state.retrieval.findRelevant(userText, {
                    limit: state.memoryRecallConfig.maxRecall,
                    sessionID: sid,
                });

                logger.info('[Recall]', 'findRelevant returned:', relevant.length, 'memories');
                if (relevant.length > 0) {
                    logger.debug('[Recall]', 'raw scores:', relevant.map((r: any) => `${r.name}=${r.relevance?.toFixed(2)}`).join(', '));
                }

                const threshold = state.memoryRecallConfig.minRelevanceScore;
                const filtered = relevant.filter((r: any) => !alreadyInjected.has(r.name) && (r.relevance ?? 0) >= threshold);
                if (filtered.length === 0) { logger.info('[Recall]', 'no memories above threshold', threshold, ', skip'); return; }

                logger.info('[Recall]', 'injecting', filtered.length, 'memories:', filtered.map((r: any) => `${r.name}(score:${r.relevance?.toFixed(2)})`).join(', '));

                const memories = await state.retrieval.loadMemories(filtered);
                const maxChars = state.memoryRecallConfig.maxInjectChars;
                const recallContent = memories.map((m: any, i: any) => {
                    const score = filtered[i]?.relevance ?? 'N/A';
                    const truncated = m.content.slice(0, maxChars) + (m.content.length > maxChars ? '...' : '');
                    const memPath = m.filepath || '';
                    return `### ${m.name} (${m.type}, score: ${score})\nPath: ${memPath}\n\n${truncated}`;
                }).join('\n\n---\n\n');

                lastUserMsg.parts.push({
                    type: 'text',
                    text: `<system-reminder>\nRelevant memories recalled for your question:\n\n${recallContent}\n</system-reminder>`,
                    synthetic: true,
                });

                if (userMsgId) {
                    recalledUserMsgIds.add(userMsgId);
                    if (recalledUserMsgIds.size > 200) {
                        const oldest = recalledUserMsgIds.values().next().value;
                        if (oldest) recalledUserMsgIds.delete(oldest);
                    }
                }

                if (state.memoryRecallConfig.visibleRecall && (!isSubagentSession(sid) || state.subagentHooksConfig.visibleRecall)) {
                    const visibleSummary = memories.map((m: any) =>
                        `${m.name}(${m.type})`
                    ).join(', ');
                    pendingRecallMap.set(sid || 'default', `Recalled ${memories.length} memories: ${visibleSummary}`);
                    logger.info('[Recall]', 'set pendingRecallMap for', sid || 'default', ':', `Recalled ${memories.length} memories: ${visibleSummary}`);
                }
 }
            catch { }
        },
        'tool.execute.after': async (input: any, output: any) => {
            if (isForkedSession(input.sessionID))
                return;
            const sid = input.sessionID;
            if (isSubagentSession(input.sessionID)) {
                if (!state.subagentHooksConfig.skillReviewTrigger)
                    return;
            } else {
                await detectAndRegisterSubagent(input.sessionID, client);
                if (isSubagentSession(input.sessionID)) {
                    if (!state.subagentHooksConfig.skillReviewTrigger)
                        return;
                }
            }
            if (state.skillConfig.enabled && (isSubagentSession(input.sessionID) ? state.subagentHooksConfig.skillReviewTrigger : true)) {
                try {
                    if (input.tool === 'skill-manage') {
                        state.skillTriggerState = resetSkillCounter(state.skillTriggerState);
                        try { await releaseSkillReviewLock(getSkillReviewLockPath(state.storage.getMemoryPath())); } catch { }
                    } else {
                        state.skillTriggerState = incrementSkillCounter(state.skillTriggerState);
                        if (!(await isSkillReviewInProgress(state.storage.getMemoryPath()))) {
                            const { shouldTrigger, newState } = checkSkillThreshold(state.skillTriggerState, state.skillConfig);
                            state.skillTriggerState = newState;
                            if (shouldTrigger && client) {
                                void spawnSkillReviewAgent({
                                    sessionID: input.sessionID,
                                    projectID: projectID,
                                    directory: directory,
                                    skillsRoot: state.skillStorage.getSkillsRoot(),
                                    memoryRoot: state.storage.getMemoryPath(),
                                    messages: [],
                                    skillConfig: state.skillConfig,
                                    client: client,
                                    reviewMode: 'skill-only',
                                });
                            }
                        }
                    }
                }
                catch { }
            }
            if (state.skillConfig.enabled && (!isSubagentSession(input.sessionID) || state.subagentHooksConfig.skillReviewTrigger)) {
                try {
                    processToolCallForSkill(input.tool);
                }
                catch { }
            }
        },
        'experimental.text.complete': async (input: any, output: any) => {
            const sid = input.sessionID || 'default';
            if (isForkedSession(sid)) return;
            const isSub = isSubagentSession(sid);
            const subHooks = state.subagentHooksConfig;
            if (isSub) {
                if (!subHooks.visibleRecall) pendingRecallMap.delete(sid);
                if (!subHooks.visibleWrite) pendingWriteMap.delete(sid);
                if (!subHooks.visibleRecall && !subHooks.visibleWrite)
                    return;
            } else {
                await detectAndRegisterSubagent(sid, client);
                if (isSubagentSession(sid)) {
                    const subHooks2 = state.subagentHooksConfig;
                    if (!subHooks2.visibleRecall) pendingRecallMap.delete(sid);
                    if (!subHooks2.visibleWrite) pendingWriteMap.delete(sid);
                    if (!subHooks2.visibleRecall && !subHooks2.visibleWrite)
                        return;
                }
            }
            const pendingWrite = pendingWriteMap.get(sid);
            const pendingRecall = pendingRecallMap.get(sid);
            const canShowWrite = pendingWrite && (!isSubagentSession(sid) || subHooks.visibleWrite);
            const canShowRecall = pendingRecall && (!isSubagentSession(sid) || subHooks.visibleRecall);
            logger.info('[TextComplete]', 'sid:', sid, 'pendingWrite:', pendingWrite || 'none', 'pendingRecall:', pendingRecall || 'none', 'canShowWrite:', canShowWrite, 'canShowRecall:', canShowRecall);
            let prefix = '';
            if (canShowWrite) {
                const writeMsg = `📝 Memory ${pendingWrite}`;
                if (!output.text.includes('📝 Memory')) {
                    prefix += writeMsg + `\n\n`;
                    logger.info('[TextComplete]', 'prepend writeMsg:', writeMsg.slice(0, 50));
                } else {
                    logger.debug('[TextComplete]', 'skip writeMsg (already in output.text)');
                }
                pendingWriteMap.delete(sid);
            }
            if (canShowRecall) {
                const recallMsg = `💡 ${pendingRecall}`;
                if (!output.text.includes('💡')) {
                    prefix += recallMsg + `\n\n`;
                    logger.info('[TextComplete]', 'prepend recallMsg:', recallMsg.slice(0, 50));
                } else {
                    logger.debug('[TextComplete]', 'skip recallMsg (already in output.text)');
                }
                pendingRecallMap.delete(sid);
            }
            if (prefix) {
                output.text = prefix + output.text;
            }
        },
'chat.message': async (input: any, output: any) => {
            const msgInput = input;
            const sid = msgInput.sessionID || '';
            let isBg = isForkedSession(sid);
            if (!isBg && !isSubagentSession(sid)) {
                await detectAndRegisterSubagent(sid, client);
            }
            isBg = isBg || isSubagentSession(sid);
            if (isBg) {
                if (state.autoDreamConfig.enabled && state.subagentHooksConfig.autoDreamGate) {
                    try {
                        if (!isConsolidationInProgress()) {
                            void handleChatMessageTrigger({
                                sessionID: msgInput.sessionID,
                                projectID: projectID,
                                memoryRoot: state.storage.getMemoryPath(),
                                directory: directory,
                                storage: state.storage,
                                expiryConfig: state.expiryConfig,
                            });
                        }
                    }
                    catch (error) {
                        logger.error('[AutoDream]', 'chat.message hook error:', error);
                    }
                }
                return;
            }
            if (state.autoDreamConfig.enabled) {
                try {
                    if (!isConsolidationInProgress()) {
                        void handleChatMessageTrigger({
                            sessionID: msgInput.sessionID,
                            projectID: projectID,
                            memoryRoot: state.storage.getMemoryPath(),
                            directory: directory,
                            storage: state.storage,
                            expiryConfig: state.expiryConfig,
                        });
                    }
                }
                catch (error) {
                    logger.error('[AutoDream]', 'chat.message hook error:', error);
                }
            }
            if (state.slashCommandsEnabled && state.client) {
                try {
                    if (!msgInput.agent) {
                        const outputObj = output;
                        const parts = outputObj.parts || [];
                        let messageContent = '';
                        for (const part of parts) {
                            if (part.type === 'text') {
                                messageContent = part.text || '';
                                break;
                            }
                        }
                        if (isSlashCommand(messageContent)) {
                            const parsed = parseSlashCommand(messageContent, state.commandRegistry);
                            if (parsed.recognized) {
                                const cmd = state.commandRegistry.lookup(parsed.command);
                                if (cmd && state.client) {
                                    if (cmd.targetTool === 'skill-review-trigger') {
                                        void spawnSkillReviewAgent({
                                            sessionID: msgInput.sessionID,
                                            projectID: projectID,
                                            directory: directory,
                                            skillsRoot: state.skillStorage.getSkillsRoot(),
                                            memoryRoot: state.storage.getMemoryPath(),
                                            messages: msgInput.messages || [],
                                            skillConfig: state.skillConfig,
                                            client: state.client,
                                            reviewMode: 'skill-only',
                                        });
                                    }
                                    else if (cmd.targetTool === 'dream-approve') {
                                        void state.client.session.prompt({
                                            path: { id: msgInput.sessionID },
                                            body: {
                                                parts: [{ type: 'text', text: 'Please call the dream-approve tool to confirm deletion of expired memories. Do not explain, just call the tool.' }],
                                            },
                                        }).then((result: any) => {
                                            if (result.error) logger.error('[SlashCommand]', 'Failed to send prompt:', result.error);
                                        }).catch((err: any) => logger.error('[SlashCommand]', 'Prompt error:', err));
                                    }
                                    else if (cmd.targetTool === 'dream-reject') {
                                        void state.client.session.prompt({
                                            path: { id: msgInput.sessionID },
                                            body: {
                                                parts: [{ type: 'text', text: 'Please call the dream-reject tool to cancel pending expiry deletions. Do not explain, just call the tool.' }],
                                            },
                                        }).then((result: any) => {
                                            if (result.error) logger.error('[SlashCommand]', 'Failed to send prompt:', result.error);
                                        }).catch((err: any) => logger.error('[SlashCommand]', 'Prompt error:', err));
                                    }
                                    else {
                                        const forceArg = parsed.args.force ? ' with force=true' : '';
                                        const promptText = `Please call the ${cmd.targetTool} tool${forceArg} to run memory consolidation. Do not explain, just call the tool.`;
                                        void state.client.session.prompt({
                                            path: { id: msgInput.sessionID },
                                            body: {
                                                parts: [{ type: 'text', text: promptText }],
                                            },
                                        }).then((result: any) => {
                                            if (result.error) {
                                                logger.error('[SlashCommand]', 'Failed to send prompt:', result.error);
                                            }
                                        }).catch((err: any) => {
                                            logger.error('[SlashCommand]', 'Prompt error:', err);
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
                catch { }
            }
            
},
        tool: {
            'memory-read': {
                description: 'Read project memories. (Auto-Memory feature)',
                args: {
                    name: z.string().optional().describe('Memory name to read'),
                },
                async execute(args: any, _ctx: any) {
                    if (!state.config.enabled) {
                        return 'Auto-Memory is disabled. Enable it via config: autoMemory.enabled = true';
                    }
                    try {
                        const name = args.name;
                        if (name) {
                            const memory = await state.storage.read(name);
                            if (!memory)
                                return 'Memory not found: ' + name;
                            let result = '## ' + memory.name + '\n\n' + memory.content;
                            if (memory.mtime) {
                                const ageDays = Math.round((Date.now() - memory.mtime) / (1000 * 60 * 60 * 24));
                                if (ageDays > 1) {
                                    result += `\n\n<system-reminder>This memory is ${ageDays} days old. Memories are point-in-time observations — claims about code behavior may be outdated. Verify against current code before asserting as fact.</system-reminder>`;
                                }
                            }
                            const notice = await getPendingExpiryNotice(state);
                            if (notice) result += notice;
                            await showPendingExpiryToast(state);
                            return result;
                        }
                        const headers = await state.storage.list();
                        const stats = await state.storage.getStats();
                        let output = '## Project Memories (' + headers.length + ' total)\n\n';
                        for (let i = 0; i < headers.length; i++) {
                            const h = headers[i];
                            output += (i + 1) + '. **' + h.name + '** (' + h.type + ')\n';
                            output += '   ' + h.description + '\n\n';
                        }
                        output += '\n---\n\n**Stats:** ' + stats.total + ' total\n';
                        const notice = await getPendingExpiryNotice(state);
                        if (notice) output += notice;
                        await showPendingExpiryToast(state);
                        return output;
                    }
                    catch (e) {
                        return e instanceof Error ? e.message : 'Unknown error';
                    }
                },
            },
            'memory-write': {
                description: 'Write or update a project memory. (Auto-Memory feature)',
                args: {
                    name: z.string().describe('Memory name'),
                    description: z.string().describe('One-line summary'),
                    type: z.enum(['user', 'feedback', 'project', 'reference']),
                    content: z.string().describe('Memory content'),
                    pin: z.boolean().optional().describe('Pin memory to prevent expiry (default: false)'),
                    ttl: z.number().optional().describe('Custom TTL in days (overrides type default)'),
                },
                async execute(args: any, ctx: any) {
                    if (!state.config.enabled) {
                        return {
                            title: 'Auto-Memory disabled',
                            output: 'Auto-Memory is disabled. Enable it via config: autoMemory.enabled = true',
                            metadata: {},
                        };
                    }
                    try {
                        const name = args.name;
                        const description = args.description;
                        const type = args.type;
                        const content = args.content;
                        const pin = args.pin;
                        const ttl = args.ttl;
                        const existing = await state.storage.read(name);
                        const memory = await state.storage.write({
                            name,
                            description,
                            type,
                            content,
                            created: existing?.created,
                            pin,
                            ttl,
                        });
                        const action = existing ? 'updated' : 'created';
                        const sid = ctx.sessionID || 'default';
                        const visibleWriteEnabled = state.memoryRecallConfig.visibleWrite && (!isSubagentSession(sid) || state.subagentHooksConfig.visibleWrite);
                        if (visibleWriteEnabled) {
                            setPendingWrite(sid, `'${memory.name}' ${action}`);
                        }
                        await showPendingExpiryToast(state);
                        const expiryNotice = await getPendingExpiryNotice(state);
                        return {
                            title: visibleWriteEnabled ? `📝 Memory '${memory.name}' ${action}` : `Memory '${memory.name}' ${action}`,
                            output: `Memory ${memory.name} ${action}${expiryNotice ?? ''}`,
                            metadata: visibleWriteEnabled ? { notification: `📝 Memory '${memory.name}' ${action}` } : {},
                        };
                    }
                    catch (e) {
                        return {
                            title: 'Memory write error',
                            output: e instanceof Error ? e.message : 'Unknown error',
                            metadata: { error: true },
                        };
                    }
                },
            },
            'memory-search': {
                description: 'Search project memories. (Auto-Memory feature)',
                args: {
                    query: z.string().describe('Search query'),
                    limit: z.number().default(5),
                },
                async execute(args: any, ctx: any) {
                    if (!state.config.enabled) {
                        return {
                            title: 'Auto-Memory disabled',
                            output: 'Auto-Memory is disabled. Enable it via config: autoMemory.enabled = true',
                            metadata: {}
                        };
                    }
                    try {
                        const query = args.query;
                        const limit = args.limit || 5;
                        const relevant = await state.retrieval.findRelevant(query, { limit, sessionID: ctx?.sessionID });
                        const memories = await state.retrieval.loadMemories(relevant);
                        let output = '## Search: ' + query + '\n\n';
                        for (let i = 0; i < memories.length; i++) {
                            const m = memories[i];
                            let content = m.content.slice(0, 200);
                            if (m.mtime) {
                                const ageDays = Math.round((Date.now() - m.mtime) / (1000 * 60 * 60 * 24));
                                if (ageDays > 1) {
                                    content += `\n<system-reminder>This memory is ${ageDays} days old. Verify against current code before asserting as fact.</system-reminder>`;
                                }
                            }
                            output += (i + 1) + '. **' + m.name + '**\n' + content + '\n\n';
                        }
                        const expiryNotice = await getPendingExpiryNotice(state);
                        if (expiryNotice) output += expiryNotice;
                        await showPendingExpiryToast(state);
                        const sid = ctx.sessionID || 'default';
                        const visibleRecallEnabled = state.memoryRecallConfig.visibleRecall && (!isSubagentSession(sid) || state.subagentHooksConfig.visibleRecall);
                        return {
                            title: visibleRecallEnabled ? '💡 Memory search: ' + query : 'Memory search: ' + query,
                            output: output,
                            metadata: { count: memories.length, query }
                        };
                    }
                    catch (e) {
                        return {
                            title: 'Memory search error',
                            output: e instanceof Error ? e.message : 'Unknown error',
                            metadata: { error: true }
                        };
                    }
                },
            },
            'memory-delete': {
                description: 'Delete a project memory. (Auto-Memory feature)',
                args: {
                    name: z.string().describe('Memory name to delete'),
                },
                async execute(args: any, _ctx: any) {
                    if (!state.config.enabled) {
                        return {
                            title: 'Auto-Memory disabled',
                            output: 'Auto-Memory is disabled. Enable it via config: autoMemory.enabled = true',
                            metadata: {}
                        };
                    }
                    try {
                        const name = args.name;
                        const deleted = await state.storage.delete(name);
                        return {
                            title: deleted ? `Memory deleted: ${name}` : `Memory not found: ${name}`,
                            output: deleted ? 'Deleted: ' + name : 'Not found: ' + name,
                            metadata: { deleted, name }
                        };
                    }
                    catch (e) {
                        return {
                            title: 'Memory delete error',
                            output: e instanceof Error ? e.message : 'Unknown error',
                            metadata: { error: true }
                        };
                    }
                },
            },
            'dream-trigger': {
                description: 'Manually trigger memory consolidation (Auto Dream feature). Merges, deduplicates, and cleans up memory files.',
                args: {
                    force: z.boolean().optional().default(false).describe('Force consolidation even if thresholds not met'),
                },
                async execute(args: any, ctx: any) {
                    if (!state.autoDreamConfig.enabled) {
                        return 'Auto Dream is disabled. Enable it via config: autoDream.enabled = true';
                    }
                    try {
                        const force = args.force || false;
                        const sessionID = ctx?.sessionID || 'default';
                        const memoryRoot = state.storage.getMemoryPath();
                        
                        const result = await executeAutoDream({
                            sessionID,
                            projectID: projectID,
                            memoryRoot,
                            directory: directory,
                            storage: state.storage,
                            skipGateCheck: force,
                            expiryConfig: state.expiryConfig,
                        });
                        
                        if (!result.success) {
                            return '## Dream Trigger Failed\n\n' + (result.error || 'Unknown error');
                        }
                        
                        return '## Dream Trigger Launched\n\n' +
                            '**Gate status:** time=' + (result.gateStatus?.timeGate ?? 'bypassed') + ', session=' + (result.gateStatus?.sessionGate ?? 'bypassed') + '\n\n' +
                            'Dream agent is running in the background. It will consolidate memories, release the lock, and update state autonomously.';
                    }
                    catch (e) {
                        return e instanceof Error ? e.message : 'Unknown error';
                    }
                },
            },
            'dream-approve': {
                description: 'Approve pending memory expiry deletions. Deletes all memories listed in .pending-expiry.json and clears the file.',
                args: {},
                async execute(_args: any, _ctx: any) {
                    if (!state.expiryConfig?.enabled) {
                        return 'Memory expiry is disabled.';
                    }
                    try {
                        const pending = await state.storage.readPendingExpiry();
                        if (!pending || pending.pendingDeletions.length === 0) {
                            return '## No Pending Expiry\n\nNo memories are pending deletion.';
                        }
                        let deletedCount = 0;
                        let failedCount = 0;
                        for (const d of pending.pendingDeletions) {
                            const ok = await state.storage.delete(d.name);
                            if (ok) deletedCount++;
                            else failedCount++;
                        }
                        await state.storage.clearPendingExpiry();
                        pendingExpiryToastShown = false;
                        let msg = `## Expiry Approved\n\nDeleted ${deletedCount} expired memories.`;
                        if (failedCount > 0) msg += ` Failed to delete ${failedCount} memories.`;
                        return msg;
                    }
                    catch (e) {
                        return e instanceof Error ? e.message : 'Unknown error';
                    }
                },
            },
            'dream-reject': {
                description: 'Reject pending memory expiry deletions. Keeps all memories and clears .pending-expiry.json.',
                args: {},
                async execute(_args: any, _ctx: any) {
                    if (!state.expiryConfig?.enabled) {
                        return 'Memory expiry is disabled.';
                    }
                    try {
                        const pending = await state.storage.readPendingExpiry();
                        if (!pending || pending.pendingDeletions.length === 0) {
                            return '## No Pending Expiry\n\nNo memories are pending deletion.';
                        }
                        const count = pending.pendingDeletions.length;
                        await state.storage.clearPendingExpiry();
                        pendingExpiryToastShown = false;
                        return `## Expiry Rejected\n\nKept ${count} memories. Pending expiry cleared.`;
                    }
                    catch (e) {
                        return e instanceof Error ? e.message : 'Unknown error';
                    }
                },
            },
            'skill-manage': skillManageTool,
            'skill-list': skillListTool,
            'skill-view': skillViewTool,
        },
    };
    return hooks;
};

export default MemoryPlugin;

