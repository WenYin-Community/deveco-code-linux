// Auto Dream Module - Automatic Memory Consolidation
export {
  initAutoDream,
  getAutoDreamRunner,
  executeAutoDream,
  handleChatMessageTrigger,
  isGateOpen,
  checkTimeGate,
  checkSessionGate,
  checkAllGates,
} from './autoDream'
export type {
  AutoDreamContext,
  AutoDreamResult,
  AutoDreamRunner,
} from './autoDream'

export {
  getLockFilePath,
  readConsolidationLock,
  writeConsolidationLock,
  tryAcquireConsolidationLock,
  releaseConsolidationLock,
  rollbackConsolidationLock,
  isProcessRunning,
} from './consolidationLock'

export {
  DREAM_CONSOLIDATION_PROMPT,
  buildDreamPrompt,
} from './dreamPrompt'

export {
  DEFAULT_DREAM_STATE,
  readDreamState,
  writeDreamState,
  updateDreamState,
  incrementSessionCount,
  markConsolidationComplete,
  resetSessionCount,
  getDreamStatePath,
} from './dreamState'
export type { AutoDreamState } from './dreamState'
