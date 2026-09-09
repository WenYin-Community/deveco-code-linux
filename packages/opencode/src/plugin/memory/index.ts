import type { Plugin, PluginInput, PluginOptions, Hooks, ToolContext } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { initLogger, logger, setLogDir, type LogLevel } from './util/logger';
import { MemoryStorage } from './memory/storage';
import { normalizeProjectPath, getGlobalDataDir } from './util/path';
import { MemoryInjection } from './memory/injection';
import { SessionInjectionSnapshotCache, computeInjectionBlocks } from './memory/injectionSnapshot';
import { EnhancedMemoryRetrieval } from './memory/enhanced-retrieval';
import { DEFAULT_MEMORY_CONFIG, z, DEFAULT_AUTO_DREAM_CONFIG, DEFAULT_EXTRACTION_CONFIG, DEFAULT_TRUNCATION_CONFIG, DEFAULT_SKILL_CONFIG, DEFAULT_MEMORY_RECALL_CONFIG, DEFAULT_SEMANTIC_SELECTION_CONFIG, DEFAULT_MEMORY_EXPIRY_CONFIG, type MemoryConfig, type AutoDreamConfig, type ExtractionConfig, type SkillConfig, type MemoryRecallConfig, type SemanticSelectionConfig, type MemoryType } from './memory/types';
// Auto Dream imports
import { initAutoDream, executeAutoDream, handleChatMessageTrigger, checkAllGates, isConsolidationInProgress, markDreamDone } from './autoDream/autoDream';
import { isForkedSession, unregisterForkSession, getForkSessionAgent, LOCK_FILE_NAMES } from './util/forkManager';
import { isSubagentSession, detectAndRegisterSubagent } from './util/subagentManager';


// Auto Memory Extraction imports
import { initAutoMemoryExtraction, getExtractionRunner, } from './memory/extractionRunner';
import { releaseExtractionLock } from './memory/extractionLock';
import { processToolCallForSkill, incrementTurnCounter, markExtractionCompleted, resetExtractionSkillCounter, getThresholdState, updateThresholdState } from './memory/extractionThreshold';
// Skills imports
import { SkillStorage, SkillInjection } from './skills';
import { checkSkillThreshold, incrementSkillCounter, resetSkillCounter, DEFAULT_SKILL_TRIGGER_STATE, } from './skills/trigger';
import { spawnSkillReviewAgent, isSkillReviewInProgress, releaseSkillReviewLock, getSkillReviewLockPath } from './skills/reviewAgent';
import { skillManageTool, skillListTool, skillViewTool, setSkillEnabled } from './skills/tools';
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

interface PluginState {
    storage: MemoryStorage
    retrieval: EnhancedMemoryRetrieval
    injection: MemoryInjection
    injectionSnapshots: SessionInjectionSnapshotCache
    config: ReturnType<typeof mergeConfig>['autoMemory']
    autoDreamConfig: ReturnType<typeof mergeConfig>['autoDream']
    extractionConfig: ReturnType<typeof mergeConfig>['extraction']
    skillStorage: SkillStorage
    skillInjection: SkillInjection
    skillConfig: ReturnType<typeof mergeConfig>['skills']
    skillTriggerState: typeof DEFAULT_SKILL_TRIGGER_STATE
    slashCommandsEnabled: boolean
    commandRegistry: ReturnType<typeof getCommandRegistry>
    client: OpencodeClient | undefined
    memoryRecallConfig: ReturnType<typeof mergeConfig>['memoryRecall']
    semanticSelectionConfig: ReturnType<typeof mergeConfig>['semanticSelection']
    subagentHooksConfig: typeof DEFAULT_SUBAGENT_HOOKS_CONFIG
    expiryConfig: ReturnType<typeof mergeConfig>['expiry']
    pendingRecallMap: Map<string, string>
    pendingWriteMap: Map<string, string>
    recalledUserMsgIds: Set<string>
    pendingExpiryToastShown: boolean
    memoryToolUsedThisTurn: Set<string>
}

interface PendingDeletion {
    name: string
    type: string
    ageDays: number
    ttlDays: number | null
}

const stateMap = new Map<string, PluginState>();
const initPromises = new Map<string, Promise<PluginState>>();
// Projects whose leftover extraction-fork sessions have been swept on startup.
// The session.idle handler only deletes NEW completions; this one-time sweep
// removes pre-existing / crash-before-idle extraction forks from prior runs.
const sweptProjects = new Set<string>();

async function getPendingExpiryNotice(state: PluginState): Promise<string | null> {
    if (!state.expiryConfig?.enabled) return null;
    const pending = await state.storage.readPendingExpiry();
    if (!pending || pending.pendingDeletions.length === 0) return null;
    const items = pending.pendingDeletions.map((d: PendingDeletion) => `- **${d.name}** (${d.type}, age: ${d.ageDays}d, TTL: ${d.ttlDays ?? '∞'})`).join('\n');
    return `\n\n---\n⚠️ **Pending expiry**: ${pending.pendingDeletions.length} memories marked for deletion:\n${items}\n\n**You MUST immediately use the \`question\` tool to present the user with interactive approve/reject choices.** Do not just describe the expiry passively — ask the user to decide: "确认删除" (call \`dream-approve\`) or "保留" (call \`dream-reject\`).`;
}

async function showPendingExpiryToast(state: PluginState): Promise<void> {
    if (state.pendingExpiryToastShown || !state.client) return;
    const pending = await state.storage.readPendingExpiry();
    if (!pending || pending.pendingDeletions.length === 0) return;
    state.pendingExpiryToastShown = true;
    try {
        await state.client.tui.showToast({
            body: {
                title: '⚠️ Pending expiry',
                message: `${pending.pendingDeletions.length} memories marked for deletion. Approve or keep them via the prompt in chat.`,
                variant: 'warning',
                duration: 6000,
            },
        });
    } catch (e) { logger.error('[PendingExpiry]', 'toast failed:', e); }
}

type PluginConfig = Record<string, unknown> & {
    autoMemory?: Record<string, unknown>
    autoDream?: Record<string, unknown>
    extraction?: Record<string, unknown>
    skills?: Record<string, unknown>
    memoryRecall?: Record<string, unknown>
    semanticSelection?: Record<string, unknown>
    subagentHooks?: Record<string, unknown>
}

function mergeAutoMemoryConfig(pc: PluginConfig): MemoryConfig {
    const am = pc.autoMemory as Record<string, unknown> | undefined;
    const D = DEFAULT_MEMORY_CONFIG;
    const r = (key: string, def: unknown) => (pc as Record<string, unknown>)[key] ?? am?.[key] ?? def;
    return {
        ...D,
        ...am,
        enabled: am?.enabled ?? pc.enabled ?? D.enabled,
        maxMemoryFiles: r('maxMemoryFiles', D.maxMemoryFiles),
        maxEntrypointLines: r('maxEntrypointLines', D.maxEntrypointLines),
        maxEntrypointBytes: r('maxEntrypointBytes', D.maxEntrypointBytes),
        storageMode: r('storageMode', D.storageMode),
        customMemoryDir: r('customMemoryDir', undefined),
        minSessionsBeforeConsolidation: r('minSessionsBeforeConsolidation', D.minSessionsBeforeConsolidation),
        minHoursBetweenConsolidation: r('minHoursBetweenConsolidation', D.minHoursBetweenConsolidation),
        truncation: {
            ...DEFAULT_TRUNCATION_CONFIG,
            ...(am?.truncation as Record<string, unknown> | undefined),
        },
    } as MemoryConfig;
}

function mergeAutoDreamConfig(pc: PluginConfig): AutoDreamConfig {
    return {
        ...DEFAULT_AUTO_DREAM_CONFIG,
        ...(pc.autoDream as Record<string, unknown> | undefined),
        enabled: pc.autoDream?.enabled ?? DEFAULT_AUTO_DREAM_CONFIG.enabled,
    } as AutoDreamConfig;
}

function mergeExtractionConfig(pc: PluginConfig): ExtractionConfig {
    const ex = pc.extraction;
    return {
        ...DEFAULT_EXTRACTION_CONFIG,
        ...(ex as Record<string, unknown> | undefined),
        enabled: ex?.enabled ?? DEFAULT_EXTRACTION_CONFIG.enabled,
        syncMode: ex?.syncMode ?? DEFAULT_EXTRACTION_CONFIG.syncMode,
        syncWaitTimeoutMs: ex?.syncWaitTimeoutMs ?? DEFAULT_EXTRACTION_CONFIG.syncWaitTimeoutMs,
    } as ExtractionConfig;
}

function mergeSkillConfig(pc: PluginConfig): SkillConfig {
    return {
        ...DEFAULT_SKILL_CONFIG,
        ...(pc.skills as Record<string, unknown> | undefined),
        enabled: pc.skills?.enabled ?? DEFAULT_SKILL_CONFIG.enabled,
    } as SkillConfig;
}

function mergeMemoryRecallConfig(pc: PluginConfig): MemoryRecallConfig {
    const mr = pc.memoryRecall;
    return {
        ...DEFAULT_MEMORY_RECALL_CONFIG,
        ...(mr as Record<string, unknown> | undefined),
        enabled: mr?.enabled ?? DEFAULT_MEMORY_RECALL_CONFIG.enabled,
        visibleRecall: mr?.visibleRecall ?? DEFAULT_MEMORY_RECALL_CONFIG.visibleRecall,
        visibleWrite: mr?.visibleWrite ?? DEFAULT_MEMORY_RECALL_CONFIG.visibleWrite,
        minRelevanceScore: mr?.minRelevanceScore ?? DEFAULT_MEMORY_RECALL_CONFIG.minRelevanceScore,
        maxInjectChars: mr?.maxInjectChars ?? DEFAULT_MEMORY_RECALL_CONFIG.maxInjectChars,
    } as MemoryRecallConfig;
}

function mergeSemanticSelectionConfig(pc: PluginConfig): SemanticSelectionConfig {
    return {
        ...DEFAULT_SEMANTIC_SELECTION_CONFIG,
        ...(pc.semanticSelection as Record<string, unknown> | undefined),
        enabled: pc.semanticSelection?.enabled ?? DEFAULT_SEMANTIC_SELECTION_CONFIG.enabled,
    } as SemanticSelectionConfig;
}

function mergeSubagentHooksConfig(pc: PluginConfig) {
    return {
        ...DEFAULT_SUBAGENT_HOOKS_CONFIG,
        ...(pc.subagentHooks as Record<string, unknown> | undefined),
    };
}

function mergeExpiryConfig(pc: PluginConfig) {
    const userExpiry = pc.autoMemory?.expiry as Record<string, unknown> | undefined;
    return {
        ...DEFAULT_MEMORY_EXPIRY_CONFIG,
        ...userExpiry,
        ttlByType: {
            ...DEFAULT_MEMORY_EXPIRY_CONFIG.ttlByType,
            ...(userExpiry?.ttlByType as Record<string, unknown> | undefined),
        },
    };
}

function mergeConfig(pluginConfig: PluginConfig) {
    return {
        autoMemory: mergeAutoMemoryConfig(pluginConfig),
        autoDream: mergeAutoDreamConfig(pluginConfig),
        extraction: mergeExtractionConfig(pluginConfig),
        skills: mergeSkillConfig(pluginConfig),
        memoryRecall: mergeMemoryRecallConfig(pluginConfig),
        semanticSelection: mergeSemanticSelectionConfig(pluginConfig),
        subagentHooks: mergeSubagentHooksConfig(pluginConfig),
        expiry: mergeExpiryConfig(pluginConfig),
    };
}

const SLASH_COMMAND_TARGET_MAP: Record<string, string> = {
    'dream': 'dream-trigger',
    'dream-force': 'dream-trigger',
    'dream-approve': 'dream-approve',
    'dream-reject': 'dream-reject',
    'auto-skill': 'skill-review-trigger',
};

function resolvePluginConfigs(pluginConfig: PluginConfig) {
    const logLevel = (pluginConfig.logLevel as LogLevel) || 'error';
    initLogger(logLevel);
    const configs = mergeConfig(pluginConfig);
    setSkillEnabled(configs.skills.enabled);
    const slashCommandsEnabled = (pluginConfig.slashCommands as Record<string, unknown> | undefined)?.enabled ?? true;
    return { logLevel, configs, slashCommandsEnabled: slashCommandsEnabled as boolean };
}

async function registerSkillSlashCommands(
    skillStorage: SkillStorage,
    commandRegistry: ReturnType<typeof getCommandRegistry>,
): Promise<void> {
    const skillsWithCommand = await skillStorage.getSkillsWithSlashCommand();
    for (const s of skillsWithCommand) {
        const targetTool = SLASH_COMMAND_TARGET_MAP[s.slashCommand] || 'dream-trigger';
        commandRegistry.register({
            name: s.slashCommand,
            targetTool,
            skillName: s.skillName,
            args: targetTool === 'dream-trigger' ? ['force'] : [],
        });
    }
}

function createPluginState(
    fullConfig: MemoryConfig,
    memoryRecallConfig: MemoryRecallConfig,
    semanticSelectionConfig: SemanticSelectionConfig,
    client: OpencodeClient | undefined,
    projectID: string,
    directory: string,
    configs: ReturnType<typeof mergeConfig>,
    slashCommandsEnabled: boolean,
): PluginState {
    const storage = new MemoryStorage(projectID, directory, fullConfig);
    const skillStorage = new SkillStorage();
    const skillInjection = new SkillInjection(skillStorage, configs.skills);
    const commandRegistry = getCommandRegistry();
    return {
        storage,
        retrieval: new EnhancedMemoryRetrieval(storage, fullConfig, memoryRecallConfig, semanticSelectionConfig, client),
        injection: new MemoryInjection(storage, fullConfig),
        injectionSnapshots: new SessionInjectionSnapshotCache(),
        config: fullConfig,
        autoDreamConfig: configs.autoDream,
        extractionConfig: configs.extraction,
        skillStorage,
        skillInjection,
        skillConfig: configs.skills,
        skillTriggerState: DEFAULT_SKILL_TRIGGER_STATE,
        slashCommandsEnabled,
        commandRegistry,
        client,
        memoryRecallConfig,
        semanticSelectionConfig,
        subagentHooksConfig: configs.subagentHooks,
        expiryConfig: configs.expiry,
        pendingRecallMap: new Map(),
        pendingWriteMap: new Map(),
        recalledUserMsgIds: new Set(),
        pendingExpiryToastShown: false,
        memoryToolUsedThisTurn: new Set(),
    };
}

async function getState(projectID: string, directory: string, pluginConfig: PluginConfig = {}, client?: OpencodeClient): Promise<PluginState> {
    const existing = stateMap.get(projectID);
    if (existing) return existing;
    const inflight = initPromises.get(projectID);
    if (inflight) return inflight;

    const initPromise = (async (): Promise<PluginState> => {
        const { logLevel, configs, slashCommandsEnabled } = resolvePluginConfigs(pluginConfig);
        const { autoMemory: fullConfig, memoryRecall: memoryRecallConfig, semanticSelection: semanticSelectionConfig } = configs;
        const storage = new MemoryStorage(projectID, directory, fullConfig);
        await storage.init();
        if (logLevel !== 'off') await setLogDir(storage.getMemoryPath() + '/logs');
        logger.info('[PluginInit]', 'projectID:', projectID, 'memoryPath:', storage.getMemoryPath());
        const skillStorage = new SkillStorage();
        await skillStorage.init();
        if (slashCommandsEnabled) {
            try {
                await registerSkillSlashCommands(skillStorage, getCommandRegistry());
            } catch (e) {
                logger.warn('[PluginInit]', 'Failed to register skill slash commands:', e instanceof Error ? e.message : String(e));
            }
        }
        const state = createPluginState(fullConfig, memoryRecallConfig, semanticSelectionConfig, client, projectID, directory, configs, slashCommandsEnabled);
        if (client) {
            initAutoDream(client, storage, configs.autoDream);
        }
        if (client && fullConfig.enabled) {
            initAutoMemoryExtraction(client, storage, configs.extraction, undefined, skillStorage, configs.skills);
        }
        stateMap.set(projectID, state);
        return state;
    })();

    initPromises.set(projectID, initPromise);
    try {
        return await initPromise;
    } finally {
        initPromises.delete(projectID);
    }
}

const MEMORY_CONFIG_FILENAME = 'memory-config.json'

async function loadMemoryConfigFile(configPath: string): Promise<PluginConfig> {
    try {
        const file = Bun.file(configPath)
        if (!(await file.exists())) return {}
        const parsed = await file.json()
        logger.info('[PluginInit]', 'Loaded memory config from:', configPath)
        return parsed as PluginConfig
    } catch (e) {
        logger.warn('[PluginInit]', 'Failed to load memory config:', configPath, e instanceof Error ? e.message : String(e))
        return {}
    }
}

async function loadMemoryConfigs(directory: string): Promise<PluginConfig> {
    // Merge order: user-level < project-level < options (later overrides earlier)
    const userConfig = await loadMemoryConfigFile(`${getGlobalDataDir()}/${MEMORY_CONFIG_FILENAME}`)
    const projectConfig = directory
        ? await loadMemoryConfigFile(`${directory}/.deveco/${MEMORY_CONFIG_FILENAME}`)
        : {}
    // Deep merge top-level config sections so nested keys aren't lost
    const merged: Record<string, unknown> = { ...userConfig }
    for (const [key, value] of Object.entries(projectConfig)) {
        const existing = merged[key]
        if (existing && typeof existing === 'object' && typeof value === 'object' && !Array.isArray(value)) {
            merged[key] = { ...(existing as Record<string, unknown>), ...(value as Record<string, unknown>) }
        } else {
            merged[key] = value
        }
    }
    return merged as PluginConfig
}

// ============================================================================
// Hook Helper Functions
// ============================================================================

interface MessagesTransformOutput {
    messages: Array<{ info?: { sessionID?: string; role?: string; id?: string }; parts: Array<Record<string, unknown>> }>
}

function handleForkedSessionPermission(
    permission: string,
    pattern: string,
    output: { status: string },
    skillEnabled: boolean,
): void {
    const alwaysSafe = [
        'read', 'grep', 'glob',
        'memory-read', 'memory-write', 'memory-search', 'memory-delete',
        'skill-list', 'skill-view',
        ...(skillEnabled ? ['skill-manage'] : []),
        'external_directory',
    ];
    if (alwaysSafe.includes(permission)) {
        output.status = 'allow';
        logger.info('[PermissionAsk]', 'Auto-allowed (forked session):', permission);
        return;
    }
    if (permission === 'edit') {
        const baseName = pattern.split(/[/\\]/).pop() || '';
        const isLockFile = LOCK_FILE_NAMES.includes(baseName as typeof LOCK_FILE_NAMES[number]);
        output.status = isLockFile ? 'allow' : 'deny';
        logger.info('[PermissionAsk]', isLockFile ? 'Auto-allowed edit (lock file):' : 'Denied edit (non-lock file):', pattern);
        return;
    }
    output.status = 'deny';
    logger.info('[PermissionAsk]', 'Denied (forked session):', permission);
}

function handlePermissionAsk(input: Record<string, unknown>, output: { status: string }, state: PluginState): void {
    const sessionID = (input.sessionID as string) || '';
    const permission = (input as unknown as Record<string, string>).permission || '';
    const pattern = Array.isArray(input.pattern) ? (input.pattern as string[])[0] || '' : ((input.pattern as string) || '');
    logger.info('[PermissionAsk]', 'sessionID:', sessionID, 'permission:', permission, 'pattern:', pattern);
    if (isForkedSession(sessionID)) {
        handleForkedSessionPermission(permission, pattern, output, state.skillConfig.enabled);
        return;
    }
    if (permission === 'external_directory') {
        const memoryRoot = state.storage.getMemoryPath().replace(/\\/g, '/');
        const normalizedPattern = pattern.replace(/\\/g, '/');
        if (normalizedPattern.startsWith(memoryRoot) || normalizedPattern.includes(memoryRoot)) {
            output.status = 'allow';
            logger.info('[PermissionAsk]', 'Auto-allowed external_directory (fallback):', pattern, 'memoryRoot:', memoryRoot);
        }
    }
}

async function handleExtractionCleanup(sid: string, memRoot: string, state: PluginState): Promise<void> {
    try {
        await releaseExtractionLock(memRoot);
    }
    catch (e) {
        logger.warn('[SessionIdle]', 'extraction lock release failed:', e instanceof Error ? e.message : String(e));
    }
    const thresholdState = getThresholdState();
    updateThresholdState(markExtractionCompleted(thresholdState, thresholdState.pendingLastMessageUuid));
    state.skillTriggerState = resetSkillCounter(state.skillTriggerState);
    logger.info('[SessionIdle]', 'Forked extraction done — lock released, threshold reset, cursor:', thresholdState.pendingLastMessageUuid || '(none)', sid);
}

async function handleDreamCleanup(sid: string, memRoot: string): Promise<void> {
    await markDreamDone(memRoot);
    logger.info('[SessionIdle]', 'Forked dream done — consolidation lock/flag reset:', sid);
}

async function handleSkillReviewCleanup(sid: string, memRoot: string): Promise<void> {
    try {
        await releaseSkillReviewLock(getSkillReviewLockPath(memRoot));
    }
    catch (e) {
        logger.warn('[SessionIdle]', 'skill-review lock release failed:', e instanceof Error ? e.message : String(e));
    }
    updateThresholdState(resetExtractionSkillCounter(getThresholdState()));
    logger.info('[SessionIdle]', 'Forked skill-review done — lock released, skill counter reset:', sid);
}

async function handleForkedSessionIdle(sid: string, state: PluginState, client: OpencodeClient): Promise<void> {
    const agentType = getForkSessionAgent(sid);
    const memRoot = state.storage.getMemoryPath();
    if (agentType === 'extraction') {
        await handleExtractionCleanup(sid, memRoot, state);
        try {
            await client.session.delete({ path: { id: sid } });
        }
        catch (e) {
            logger.warn('[SessionIdle]', 'delete forked session failed:', e instanceof Error ? e.message : String(e));
        }
    } else if (agentType === 'dream') {
        await handleDreamCleanup(sid, memRoot);
    } else if (agentType === 'skill-review') {
        await handleSkillReviewCleanup(sid, memRoot);
    } else {
        logger.warn('[SessionIdle]', 'Forked session with unknown/missing agent type:', agentType || '(none)', sid);
    }
    unregisterForkSession(sid);
}

async function handleExtractionIdle(sid: string, state: PluginState, projectID: string, directory: string): Promise<void> {
    const isSub = isSubagentSession(sid);
    if (isSub && !state.subagentHooksConfig.autoMemoryExtraction) { return }
    if (!isSub) { updateThresholdState(incrementTurnCounter(getThresholdState())) }
    if (state.memoryToolUsedThisTurn.has(sid)) {
        state.memoryToolUsedThisTurn.delete(sid);
        logger.info('[SessionIdle]', 'Skipping extraction — memory tool used this turn:', sid);
        return;
    }
    if (state.config.enabled) {
        const extractionRunner = getExtractionRunner();
        if (extractionRunner) {
            void extractionRunner({
                sessionID: sid, projectID, memoryRoot: state.storage.getMemoryPath(),
                projectDirectory: directory, storage: state.storage,
            });
            logger.info('[SessionIdle]', 'Async extraction triggered via session.idle for:', sid);
        }
    }
}

async function handleSessionEvent(
    event: { type: string; properties?: Record<string, string> },
    state: PluginState,
    client: OpencodeClient,
    projectID: string,
    directory: string,
): Promise<void> {
    if (event.type === 'session.deleted') {
        // Evict the frozen injection snapshot so the session's blocks are not
        // pinned in memory after deletion (the cache also FIFO-bounds itself).
        const props = event.properties as { info?: { id?: string } } | undefined;
        const deletedSid = props?.info?.id || '';
        if (deletedSid) { state.injectionSnapshots.delete(deletedSid) }
        return;
    }
    if (event.type !== 'session.idle') { return }
    const sid = event.properties?.sessionID || '';
    if (!sid) { return }
    if (isForkedSession(sid)) {
        await handleForkedSessionIdle(sid, state, client);
        return;
    }
    logger.info('[SessionIdle]', 'Session idle event:', sid);
    await handleExtractionIdle(sid, state, projectID, directory);
}

async function sweepExtractionForksAsync(client: OpencodeClient): Promise<void> {
    try {
        const res = await client.session.list();
        for (const s of res.data ?? []) {
            if (!s.title?.includes('(@extraction subagent)')) { continue }
            await client.session.delete({ path: { id: s.id } });
        }
    } catch (e) {
        logger.warn('[Sweep]', 'leftover extraction-fork sweep failed:', e instanceof Error ? e.message : String(e));
    }
}

function sweepLeftoverExtractionForks(client: OpencodeClient): void {
    void sweepExtractionForksAsync(client);
}

function checkSubagentSystemPermission(subHooks: typeof DEFAULT_SUBAGENT_HOOKS_CONFIG): boolean {
    return subHooks.memoryRecall || subHooks.skillReviewTrigger || subHooks.autoMemoryExtraction;
}

async function performSystemInjections(sid: string, state: PluginState, isSubNow: boolean, output: { system: string[] }): Promise<void> {
    // Prompt-cache stability: render the memory/skill blocks once per session
    // and reuse the frozen snapshot for every subsequent request. Refresh
    // points are process start (empty cache) and new sessions (/new) — a
    // mid-session MEMORY.md rewrite must not shift the cached system prefix.
    const cached = state.injectionSnapshots.get(sid);
    if (cached) {
        output.system.push(...cached);
        return;
    }
    const { blocks, hadError } = await computeInjectionBlocks({
        injection: state.injection,
        skillInjection: state.skillInjection,
        opts: {
            truncationEnabled: state.config.truncation?.enabled !== false,
            skillsEnabled: state.skillConfig.enabled,
            slashCommandsEnabled: state.slashCommandsEnabled,
            subMemoryRecall: state.subagentHooksConfig.memoryRecall,
            subSkillReviewTrigger: state.subagentHooksConfig.skillReviewTrigger,
            isSubNow,
        },
    });
    // Never freeze a degraded render — a transient storage failure would
    // otherwise pin a memory-less prompt for the whole session.
    if (!hadError) { state.injectionSnapshots.set(sid, blocks) }
    output.system.push(...blocks);
}

async function handleSystemTransform(sid: string, state: PluginState, client: OpencodeClient, output: { system: string[] }, projectID: string): Promise<void> {
    if (!state.config.enabled) { return }
    if (isForkedSession(sid)) { return }
    if (!sweptProjects.has(projectID)) {
        sweptProjects.add(projectID);
        sweepLeftoverExtractionForks(client);
    }
    const isSub = isSubagentSession(sid);
    if (isSub) {
        if (!checkSubagentSystemPermission(state.subagentHooksConfig)) { return }
    } else {
        await detectAndRegisterSubagent(sid, client);
        if (isSubagentSession(sid) && !checkSubagentSystemPermission(state.subagentHooksConfig)) { return }
    }
    await performSystemInjections(sid, state, isSubagentSession(sid), output);
}

function extractUserQueryText(parts: Array<Record<string, unknown>>): string {
    return parts
        .filter((p) => p.type === 'text' && !(p as { synthetic?: boolean }).synthetic)
        .map((p) => (p as { text?: string }).text || '')
        .join(' ');
}

function parseAlreadyInjected(parts: Array<Record<string, unknown>>): Set<string> {
    const injected = new Set<string>();
    for (const part of parts) {
        if (part.type === 'text' && (part as { synthetic?: boolean }).synthetic && part.text) {
            const names = (part.text as string).match(/### (\S+) \(/g);
            if (names) { names.forEach((n: string) => injected.add(n.replace('### ', '').replace(' (', ''))) }
        }
    }
    return injected;
}

function buildRecallContent(
    memories: Array<{ name: string; type: string; content: string; filepath?: string }>,
    filtered: Array<{ relevance?: number }>,
    maxChars: number,
): string {
    return memories.map((m, i) => {
        const score = filtered[i]?.relevance ?? 'N/A';
        const truncated = m.content.slice(0, maxChars) + (m.content.length > maxChars ? '...' : '');
        return `### ${m.name} (${m.type}, score: ${score})\nPath: ${m.filepath || ''}\n\n${truncated}`;
    }).join('\n\n---\n\n');
}

async function resolveRecallSessionId(
    messages: MessagesTransformOutput['messages'],
    state: PluginState,
    client: OpencodeClient,
): Promise<string | null> {
    if (!messages || messages.length === 0) { return null }
    const sid = (messages[0]?.info?.sessionID || messages.findLast((m) => m.info?.role === 'user')?.info?.sessionID) || 'default';
    if (isForkedSession(sid)) { return null }
    if (isSubagentSession(sid) && !state.subagentHooksConfig.memoryRecall) { return null }
    if (sid && !isSubagentSession(sid)) {
        await detectAndRegisterSubagent(sid, client);
        if (isSubagentSession(sid) && !state.subagentHooksConfig.memoryRecall) { return null }
    }
    return sid;
}

function trackRecalledMessage(state: PluginState, userMsgId: string | undefined): void {
    if (!userMsgId) { return }
    state.recalledUserMsgIds.add(userMsgId);
    if (state.recalledUserMsgIds.size > 200) {
        const oldest = state.recalledUserMsgIds.values().next().value;
        if (oldest) { state.recalledUserMsgIds.delete(oldest) }
    }
}

function setPendingRecallNotification(
    state: PluginState,
    sid: string,
    memories: Array<{ name: string; type: string }>,
): void {
    if (!state.memoryRecallConfig.visibleRecall) { return }
    if (isSubagentSession(sid) && !state.subagentHooksConfig.visibleRecall) { return }
    const summary = memories.map((m) => `${m.name}(${m.type})`).join(', ');
    state.pendingRecallMap.set(sid || 'default', `Recalled ${memories.length} memories: ${summary}`);
}

async function handleMessagesTransform(_input: unknown, output: MessagesTransformOutput, state: PluginState, client: OpencodeClient): Promise<void> {
    if (!state.memoryRecallConfig.enabled) { return }
    try {
        const sid = await resolveRecallSessionId(output.messages, state, client);
        if (!sid) { return }
        const lastUserMsg = output.messages!.findLast((m) => m.info?.role === 'user');
        if (!lastUserMsg) { return }
        const userMsgId = lastUserMsg.info?.id;
        if (userMsgId && state.recalledUserMsgIds.has(userMsgId)) { return }
        const userText = extractUserQueryText(lastUserMsg.parts || []);
        if (!userText.trim()) { return }
        logger.info('[Recall]', 'query:', userText.slice(0, 100));
        const alreadyInjected = parseAlreadyInjected(lastUserMsg.parts || []);
        if (alreadyInjected.size > 0) { return }
        const relevant = await state.retrieval.findRelevant(userText, { limit: state.memoryRecallConfig.maxRecall, sessionID: sid });
        const threshold = state.memoryRecallConfig.minRelevanceScore;
        const filtered = relevant.filter((r) => !alreadyInjected.has(r.name) && (r.relevance ?? 0) >= threshold);
        if (filtered.length === 0) { return }
        logger.info('[Recall]', 'injecting', filtered.length, 'memories');
        const memories = await state.retrieval.loadMemories(filtered);
        const recallContent = buildRecallContent(memories, filtered, state.memoryRecallConfig.maxInjectChars);
        lastUserMsg.parts.push({
            type: 'text',
            text: `<system-reminder>\nRelevant memories recalled for your question:\n\n${recallContent}\n</system-reminder>`,
            synthetic: true,
        });
        trackRecalledMessage(state, userMsgId);
        setPendingRecallNotification(state, sid, memories);
    } catch (e) {
        logger.error('[Recall]', 'messages.transform error:', e instanceof Error ? e.message : String(e));
    }
}

async function handleSkillManageTrigger(state: PluginState): Promise<void> {
    state.skillTriggerState = resetSkillCounter(state.skillTriggerState);
    try {
        await releaseSkillReviewLock(getSkillReviewLockPath(state.storage.getMemoryPath()));
    } catch (e) {
        logger.warn('[ToolExecute]', 'skill-review lock release failed:', e instanceof Error ? e.message : String(e));
    }
}

async function handleSkillReviewTrigger(
    input: { tool: string; sessionID: string },
    state: PluginState,
    client: OpencodeClient,
    projectID: string,
    directory: string,
): Promise<void> {
    state.skillTriggerState = incrementSkillCounter(state.skillTriggerState);
    if (await isSkillReviewInProgress(state.storage.getMemoryPath())) { return }
    const { shouldTrigger, newState } = checkSkillThreshold(state.skillTriggerState, state.skillConfig);
    state.skillTriggerState = newState;
    if (shouldTrigger && client) {
        void spawnSkillReviewAgent({
            sessionID: input.sessionID, projectID, directory,
            skillsRoot: state.skillStorage.getSkillsRoot(),
            memoryRoot: state.storage.getMemoryPath(),
            messages: [], skillConfig: state.skillConfig, client, reviewMode: 'skill-only',
        });
    }
}

async function handleSkillTrigger(
    input: { tool: string; sessionID: string },
    state: PluginState,
    client: OpencodeClient,
    projectID: string,
    directory: string,
): Promise<void> {
    if (!state.skillConfig.enabled) { return }
    const isSub = isSubagentSession(input.sessionID);
    if (isSub && !state.subagentHooksConfig.skillReviewTrigger) { return }
    try {
        if (input.tool === 'skill-manage') {
            await handleSkillManageTrigger(state);
        } else {
            await handleSkillReviewTrigger(input, state, client, projectID, directory);
        }
    } catch (e) {
        logger.error('[ToolExecute]', 'Skill trigger check error:', e instanceof Error ? e.message : String(e));
    }
}

async function handleToolExecuteAfter(
    input: { tool: string; sessionID: string },
    state: PluginState,
    client: OpencodeClient,
    projectID: string,
    directory: string,
): Promise<void> {
    if (isForkedSession(input.sessionID)) { return }
    // Meta-tool that spawns the review agent itself: must not feed the skill
    // trigger counter (double-spawn risk) or count as user work.
    if (input.tool === 'skill-review-trigger') { return }
    if (isSubagentSession(input.sessionID)) {
        if (!state.subagentHooksConfig.skillReviewTrigger) { return }
    } else {
        await detectAndRegisterSubagent(input.sessionID, client);
        if (isSubagentSession(input.sessionID) && !state.subagentHooksConfig.skillReviewTrigger) { return }
    }
    await handleSkillTrigger(input, state, client, projectID, directory);
    if (state.skillConfig.enabled && (!isSubagentSession(input.sessionID) || state.subagentHooksConfig.skillReviewTrigger)) {
        try {
            processToolCallForSkill(input.tool);
        }
        catch (e) {
            logger.error('[ToolExecute]', 'processToolCallForSkill error:', e instanceof Error ? e.message : String(e));
        }
    }
}

function sendSlashPrompt(client: OpencodeClient, sessionID: string, text: string): void {
    void client.session.prompt({ path: { id: sessionID }, body: { parts: [{ type: 'text', text }] } })
        .then((result) => {
            if (result.error) {
                logger.error('[SlashCommand]', 'Failed to send prompt:', result.error);
            }
        })
        .catch((err) => logger.error('[SlashCommand]', 'Prompt error:', err));
}

function dispatchSlashCommand(
    cmd: { targetTool: string },
    parsed: { args: { force?: boolean } },
    state: PluginState,
    msgInput: { sessionID: string; messages?: unknown[]; agent?: string },
    projectID: string,
    directory: string,
): void {
    if (cmd.targetTool === 'skill-review-trigger') {
        void spawnSkillReviewAgent({
            sessionID: msgInput.sessionID, projectID, directory,
            skillsRoot: state.skillStorage.getSkillsRoot(), memoryRoot: state.storage.getMemoryPath(),
            messages: (msgInput as Record<string, unknown>).messages as unknown[] || [],
            skillConfig: state.skillConfig, client: state.client!, reviewMode: 'skill-only',
        });
    } else if (cmd.targetTool === 'dream-approve') {
        sendSlashPrompt(state.client!, msgInput.sessionID, 'Please call the dream-approve tool to confirm deletion of expired memories. Do not explain, just call the tool.');
    } else if (cmd.targetTool === 'dream-reject') {
        sendSlashPrompt(state.client!, msgInput.sessionID, 'Please call the dream-reject tool to cancel pending expiry deletions. Do not explain, just call the tool.');
    } else {
        const forceArg = parsed.args.force ? ' with force=true' : '';
        sendSlashPrompt(state.client!, msgInput.sessionID, `Please call the ${cmd.targetTool} tool${forceArg} to run memory consolidation. Do not explain, just call the tool.`);
    }
}

function triggerAutoDream(state: PluginState, sessionID: string, projectID: string, directory: string): void {
    if (!state.autoDreamConfig.enabled) { return }
    if (isConsolidationInProgress(state.storage.getMemoryPath())) { return }
    try {
        void handleChatMessageTrigger({
            sessionID, projectID, memoryRoot: state.storage.getMemoryPath(),
            directory, storage: state.storage, expiryConfig: state.expiryConfig,
            skillEnabled: state.skillConfig.enabled,
        });
    } catch (error) {
        logger.error('[AutoDream]', 'chat.message hook error:', error);
    }
}

function tryDispatchSlashCommand(
    input: { sessionID: string; agent?: string; messages?: unknown[] },
    state: PluginState,
    projectID: string,
    directory: string,
): void {
    if (!state.slashCommandsEnabled || !state.client || input.agent) { return }
    try {
        const parts = (input as unknown as { parts?: Array<{ type: string; text?: string }> }).parts || [];
        const textPart = parts.find((p) => p.type === 'text');
        const messageContent = textPart?.text || '';
        if (!isSlashCommand(messageContent)) { return }
        const parsed = parseSlashCommand(messageContent, state.commandRegistry);
        if (!parsed.recognized) { return }
        const cmd = state.commandRegistry.lookup(parsed.command);
        if (cmd) {
            dispatchSlashCommand(
                cmd, parsed, state,
                input as unknown as { sessionID: string; messages?: unknown[]; agent?: string },
                projectID, directory,
            );
        }
    } catch (e) {
        logger.error('[ChatMessage]', 'Slash command handling error:', e instanceof Error ? e.message : String(e));
    }
}

async function handleChatMessageHook(
    input: { sessionID: string; agent?: string; messages?: unknown[] },
    state: PluginState,
    client: OpencodeClient,
    projectID: string,
    directory: string,
): Promise<void> {
    const sid = input.sessionID || '';
    let isBg = isForkedSession(sid);
    if (!isBg && !isSubagentSession(sid)) { await detectAndRegisterSubagent(sid, client) }
    isBg = isBg || isSubagentSession(sid);
    if (isBg) {
        if (state.autoDreamConfig.enabled && state.subagentHooksConfig.autoDreamGate) { triggerAutoDream(state, sid, projectID, directory) }
        return;
    }
    triggerAutoDream(state, sid, projectID, directory);
    tryDispatchSlashCommand(input, state, projectID, directory);
}

export const MemoryPlugin: Plugin = async (input: PluginInput, options: PluginOptions = {}) => {
    const rawDirectory = input.directory || 'default';
    const projectID = normalizeProjectPath(rawDirectory);
    const directory = input.directory || rawDirectory;
    const client = input.client;
    const fileConfig = await loadMemoryConfigs(directory)
    const mergedOptions = { ...fileConfig, ...options } as PluginConfig
    logger.info('[PluginInit]', 'rawDirectory:', rawDirectory, 'projectID:', projectID, 'normalized:', projectID !== rawDirectory);
    const slashCommandsEnabled = (mergedOptions.slashCommands as Record<string, unknown> | undefined)?.enabled ?? true;
    const state = await getState(projectID, directory, mergedOptions, client);

    const hooks: Hooks = {
        dispose: async () => {
            stateMap.delete(projectID);
        },
        'permission.ask': async (input, output) => handlePermissionAsk(input as unknown as Record<string, unknown>, output as unknown as { status: string }, state),
        'event': async ({ event }) => handleSessionEvent(event as unknown as { type: string; properties?: Record<string, string> }, state, client, projectID, directory),
        'experimental.chat.system.transform': async (_input, output) => handleSystemTransform(_input.sessionID || '', state, client, output as unknown as { system: string[] }, projectID),
        'experimental.session.compacting': async (_input, output) => {
            if (!state.config.enabled) return;
            const sid = _input.sessionID || '';
            if (isForkedSession(sid)) return;
            const isSub = isSubagentSession(sid);
            if (isSub) {
                if (!state.subagentHooksConfig.memoryRecall) return;
            } else {
                await detectAndRegisterSubagent(sid, client);
                if (isSubagentSession(sid) && !state.subagentHooksConfig.memoryRecall) return;
            }
            try {
                const context = await state.injection.getCompactionContext();
                if (context) { output.context.push(context) }
            } catch (e) { logger.error('[Compacting]', 'Failed to get compaction context:', e instanceof Error ? e.message : String(e)); }
        },
        'experimental.chat.messages.transform': async (_input, output) => handleMessagesTransform(_input, output as unknown as MessagesTransformOutput, state, client),
        'tool.execute.after': async (input, output) => handleToolExecuteAfter(input, state, client, projectID, directory),
        'experimental.text.complete': async (input, output) => {
            const sid = input.sessionID || 'default';
            if (isForkedSession(sid)) return;
            const isSub = isSubagentSession(sid);
            const subHooks = state.subagentHooksConfig;
            if (isSub) {
                if (!subHooks.visibleRecall) state.pendingRecallMap.delete(sid);
                if (!subHooks.visibleWrite) state.pendingWriteMap.delete(sid);
                if (!subHooks.visibleRecall && !subHooks.visibleWrite)
                    return;
            } else {
                await detectAndRegisterSubagent(sid, client);
                if (isSubagentSession(sid)) {
                    const subHooks2 = state.subagentHooksConfig;
                    if (!subHooks2.visibleRecall) state.pendingRecallMap.delete(sid);
                    if (!subHooks2.visibleWrite) state.pendingWriteMap.delete(sid);
                    if (!subHooks2.visibleRecall && !subHooks2.visibleWrite)
                        return;
                }
            }
            const pendingWrite = state.pendingWriteMap.get(sid);
            const pendingRecall = state.pendingRecallMap.get(sid);
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
                state.pendingWriteMap.delete(sid);
            }
            if (canShowRecall) {
                const recallMsg = `💡 ${pendingRecall}`;
                if (!output.text.includes('💡')) {
                    prefix += recallMsg + `\n\n`;
                    logger.info('[TextComplete]', 'prepend recallMsg:', recallMsg.slice(0, 50));
                } else {
                    logger.debug('[TextComplete]', 'skip recallMsg (already in output.text)');
                }
                state.pendingRecallMap.delete(sid);
            }
            if (prefix) {
                output.text = prefix + output.text;
            }
        },
'chat.message': async (input, output) => handleChatMessageHook(input as unknown as { sessionID: string; agent?: string; messages?: unknown[] }, state, client, projectID, directory),
        tool: {
            'memory-read': {
                description: 'Read project memories. (Auto-Memory feature)',
                args: {
                    name: z.string().optional().describe('Memory name to read'),
                },
                async execute(args: { name?: string }, _ctx: ToolContext) {
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
                async execute(args: { name: string; description: string; type: string; content: string; pin?: boolean; ttl?: number }, ctx: ToolContext) {
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
                        const type = args.type as MemoryType;
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
                        state.memoryToolUsedThisTurn.add(sid);
                        const visibleWriteEnabled = state.memoryRecallConfig.visibleWrite && (!isSubagentSession(sid) || state.subagentHooksConfig.visibleWrite);
                        if (visibleWriteEnabled) {
                            const existing = state.pendingWriteMap.get(sid);
                            const writeText = `'${memory.name}' ${action}`;
                            state.pendingWriteMap.set(sid, existing ? existing + ', ' + writeText : writeText);
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
                async execute(args: { query: string; limit: number }, ctx: ToolContext) {
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
                async execute(args: { name: string }, ctx: ToolContext) {
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
                        if (deleted) {
                            state.memoryToolUsedThisTurn.add(ctx.sessionID || 'default');
                        }
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
                description: 'Manually trigger memory consolidation (Auto Dream feature). Merges, deduplicates, and cleans up memory files and skills. Call when the user asks to consolidate/clean/merge memories ("整理记忆", "清理记忆", "合并记忆", "强制整理", "consolidate/clean up memories", "run dream") or types /dream or /dream-force; use force=true (bypasses thresholds) whenever the user explicitly requests it.',
                args: {
                    force: z.boolean().optional().default(false).describe('Force consolidation even if thresholds not met'),
                },
                async execute(args: { force?: boolean }, ctx: ToolContext) {
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
                            skillEnabled: state.skillConfig.enabled,
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
                async execute(_args: Record<string, unknown>, _ctx: ToolContext) {
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
                        state.pendingExpiryToastShown = false;
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
                async execute(_args: Record<string, unknown>, _ctx: ToolContext) {
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
                        state.pendingExpiryToastShown = false;
                        return `## Expiry Rejected\n\nKept ${count} memories. Pending expiry cleared.`;
                    }
                    catch (e) {
                        return e instanceof Error ? e.message : 'Unknown error';
                    }
                },
            },
            'skill-review-trigger': {
                description: 'Trigger the skill review agent to extract or update skills from this conversation. Call when the user asks to create/extract/review skills ("提取技能", "总结成技能", "save this as a skill", "review my skills") or types /auto-skill. Runs in the background as a forked session.',
                args: {},
                async execute(_args: Record<string, unknown>, ctx: ToolContext) {
                    if (!state.skillConfig.enabled) {
                        return 'Skills feature is disabled. Enable it via config: skills.enabled = true';
                    }
                    if (!state.client) {
                        return 'Skill review is unavailable (no client).';
                    }
                    try {
                        const result = await spawnSkillReviewAgent({
                            sessionID: ctx?.sessionID || 'default',
                            projectID,
                            directory,
                            skillsRoot: state.skillStorage.getSkillsRoot(),
                            memoryRoot: state.storage.getMemoryPath(),
                            messages: [],
                            skillConfig: state.skillConfig,
                            client: state.client,
                            reviewMode: 'skill-only',
                        });
                        return result.success
                            ? '## Skill Review Launched\n\nSkill review agent is running in the background. It will create/update skills and release the lock autonomously.'
                            : '## Skill Review Not Started\n\n' + (result.error || 'A review may already be in progress.');
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

