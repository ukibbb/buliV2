export type { IDelegatedTask, TDelegatedTaskStatus } from "@/sessions/delegated-task"
/** Public sessions feature API for application composition and consumers. */
export { MAIN_BRANCH_ID } from "@/sessions/branches"
export { AgentSession, type IAgentSessionRunConfiguration, type ISessionConfiguration } from "@/sessions/agent-session"
export {
    assertCheckpointAnchor,
    type ICompactionCheckpoint,
} from "@/sessions/compaction/checkpoint"
export {
    projectAgentContext,
} from "@/sessions/compaction/context-projector"
export {
    createContextAwareModel,
    type IContextAwareModelOptions,
} from "@/sessions/compaction/context-aware-model"
export {
    CONTEXT_COMPACTION_THRESHOLD,
    contextCompactionThresholdTokens,
    ESTIMATED_BYTES_PER_TOKEN,
    ESTIMATED_IMAGE_TOKENS,
    estimateContextInputTokens,
    estimateContextUsage,
    estimateMessagesInputTokens,
    type IContextInput,
    type IContextEstimationPolicy,
    type IContextUsage,
    shouldCompactContext,
} from "@/sessions/compaction/context-budget"
export {
    compactSessionMessages,
    type ICompactSessionMessagesOptions,
    type ICompactionProgress,
} from "@/sessions/compaction/session-compactor"
export { SQLiteSessionManager } from "@/sessions/sqlite/sqlite-session-manager"
export { defaultHistoryDirectoryPath } from "@/sessions/session-lock"
export type { IHistoryCursor, IHistoryPage, IRequiredContext } from "@/sessions/history-contracts"
export { createInterruptedToolResults } from "@/sessions/recovery"
export type {
    ISessionInfo,
    ISessionManager,
} from "@/sessions/repository"
export {
    freezeSessionSnapshot,
    type ISessionSnapshot,
} from "@/sessions/snapshot"
export {
    assertCompactionCheckpoint,
    assertDurableSessionMessage,
    assertSessionInfo,
} from "@/sessions/validation"
