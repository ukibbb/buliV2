/** Provider-neutral model metadata shared by agent, sessions, application and UI. */
export interface ModelProfile {
    readonly providerId: string
    readonly modelId: string
    // Missing means that the provider has no verified context limit yet.
    readonly contextWindowTokens?: number
}

/** Token accounting persisted with assistant messages and compaction checkpoints. */
export interface ModelUsage {
    readonly inputTokens?: number
    readonly outputTokens?: number
    readonly totalTokens?: number
    readonly cacheReadTokens?: number
    readonly cacheWriteTokens?: number
    readonly reasoningTokens?: number
}

/** Reasoning levels understood by application selection and model adapters. */
export type ReasoningEffort =
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max"
