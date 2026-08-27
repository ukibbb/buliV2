import type {
    ReasoningEffort,
    ToolApprovalDecision,
    UserInputContent,
} from "@/agent"
import type { IFdPathSuggestion } from "@/tools"
import type {
    ICompactionCheckpoint,
    ISessionInfo,
    ISessionSnapshot,
} from "@/sessions"

export interface ISnapshotSource<Snapshot> {
    readonly subscribe: (listener: () => void) => () => void
    readonly getSnapshot: () => Snapshot
}

export interface IBuliPromptInput extends UserInputContent {
    readonly sessionId?: string
}

export type IBuliPathSuggestion = IFdPathSuggestion

export interface IBuliPromptSubmission {
    readonly sessionId: string
    readonly runId: string
    readonly accepted: Promise<void>
    readonly settled: Promise<void>
}

export interface IBuliQueuedMessages {
    readonly steering: readonly (string | UserInputContent)[]
    readonly followUp: readonly (string | UserInputContent)[]
}

export interface IBuliAgentDisplayInfo {
    readonly id: string
    readonly name: string
}

// select model and it's effort
export interface IBuliModelSelection {
    readonly modelId: string
    readonly reasoningEffort: ReasoningEffort
}

// bezpieczne dane dla ui i pickerow
export interface IBuliModelDisplayInfo {
    readonly id: string
    readonly name: string
    readonly reasoningEfforts: readonly ReasoningEffort[]
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

    readonly refreshModels: (signal?: AbortSignal) => Promise<void>
    readonly selectModel: (modelId: string) => void
    readonly selectReasoningEffort: (
        reasoningEffort: ReasoningEffort,
    ) => void

    readonly submitPrompt: (prompt: IBuliPromptInput) => IBuliPromptSubmission
    readonly steer: (
        sessionId: string,
        text: string,
        resources?: Omit<UserInputContent, "text">,
    ) => void
    readonly followUp: (
        sessionId: string,
        text: string,
        resources?: Omit<UserInputContent, "text">,
    ) => void
    readonly clearQueuedMessages: (sessionId: string) => IBuliQueuedMessages
    readonly searchPaths?: (
        query: string,
        signal?: AbortSignal,
    ) => Promise<readonly IBuliPathSuggestion[]>
    readonly resolveToolApproval: (
        sessionId: string,
        approvalId: string,
        decision: ToolApprovalDecision,
    ) => void
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
