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
    compactSessionMessages,
    findCompactionCutoff,
    type ICompactSessionMessagesOptions,
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
