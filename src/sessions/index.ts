/** Public sessions feature API for application composition and consumers. */
export { AgentSession } from "@/sessions/agent-session"
export {
    assertCheckpointAnchor,
    type ICompactionCheckpoint,
} from "@/sessions/compaction/checkpoint"
export {
    projectAgentContext,
} from "@/sessions/compaction/context-projector"
export {
    CONTEXT_SUMMARY_RESERVE_TOKENS,
    createContextAwareModel,
    type IContextAwareModelOptions,
    retainedMessageAllowanceTokens,
} from "@/sessions/compaction/context-aware-model"
export {
    CONTEXT_COMPACTION_THRESHOLD,
    contextCompactionThresholdTokens,
    ESTIMATED_CHARS_PER_TOKEN,
    ESTIMATED_IMAGE_TOKENS,
    estimateContextInputTokens,
    estimateContextUsage,
    estimateMessagesInputTokens,
    type IContextInput,
    type IContextUsage,
    shouldCompactContext,
} from "@/sessions/compaction/context-budget"
export {
    compactSessionMessages,
    findCompactionCutoff,
    type ICompactSessionMessagesOptions,
    MAX_RETAINED_CONTEXT_TOKENS,
    retainedContextTargetTokens,
} from "@/sessions/compaction/session-compactor"
export { InMemorySessionManager } from "@/sessions/in-memory-session-manager"
export {
    defaultSessionFilePath,
    JsonlSessionManager,
} from "@/sessions/jsonl/jsonl-session-manager"
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
