import type {
    TReasoningEffort,
    TToolApprovalDecision,
} from "@/agent"
import type {
    ICompactionCheckpoint,
    ISessionInfo,
    ISessionSnapshot,
} from "@/sessions"

export interface ISnapshotSource<Snapshot> {
    readonly subscribe: (listener: () => void) => () => void
    readonly getSnapshot: () => Snapshot
}

export interface IBuliPromptInput {
    readonly sessionId?: string
    readonly text: string
}

export interface IBuliPromptSubmission {
    readonly sessionId: string
    readonly runId: string
    readonly accepted: Promise<void>
    readonly settled: Promise<void>
}

export interface IBuliQueuedMessages {
    readonly steering: readonly string[]
    readonly followUp: readonly string[]
}

export interface IBuliAgentDisplayInfo {
    readonly id: string
    readonly name: string
}

// select model and it's effort
export interface IBuliModelSelection {
    readonly modelId: string
    readonly reasoningEffort: TReasoningEffort
}

// bezpieczne dane dla ui i pickerow
export interface IBuliModelDisplayInfo {
    readonly id: string
    readonly name: string
    readonly reasoningEfforts: readonly TReasoningEffort[]
}

export interface IBuliApplicationSnapshot {
    readonly agents: readonly IBuliAgentDisplayInfo[]
    readonly defaultAgentId: string
    readonly models: readonly IBuliModelDisplayInfo[]
    readonly selection: IBuliModelSelection
}

// Resolve fixed prompt and tools from the registered agent when creating a session.
export interface IBuliSessionCreationOptions {
    readonly agentId: string
    readonly title: string
}

export interface IBuliApplication
    extends ISnapshotSource<IBuliApplicationSnapshot> {
    readonly workspaceRoot: string

    readonly selectModel: (modelId: string) => void
    readonly selectReasoningEffort: (
        reasoningEffort: TReasoningEffort,
    ) => void

    readonly submitPrompt: (prompt: IBuliPromptInput) => IBuliPromptSubmission
    readonly steer: (sessionId: string, text: string) => void
    readonly followUp: (sessionId: string, text: string) => void
    readonly clearQueuedMessages: (sessionId: string) => IBuliQueuedMessages
    readonly resolveToolApproval: (
        sessionId: string,
        approvalId: string,
        decision: TToolApprovalDecision,
    ) => void
    readonly clearSession: (sessionId: string) => void
    readonly compactSession: (
        sessionId: string,
    ) => Promise<ICompactionCheckpoint | undefined>
    readonly abort: (sessionId: string) => Promise<void>
    readonly dispose: () => Promise<void>

    readonly createSession: (
        options: IBuliSessionCreationOptions,
    ) => ISessionInfo
    readonly openSession: (
        sessionId: string,
    ) => ISnapshotSource<ISessionSnapshot>
    readonly listSessions: () => readonly ISessionInfo[]
}
