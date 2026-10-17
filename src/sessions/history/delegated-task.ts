import type { TReasoningEffort } from "@/agent"

export type TDelegatedTaskStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted"

/** Durable link from one parent tool call to an isolated Explorer session. */
export interface IDelegatedTask {
    readonly id: string
    readonly parentSessionId: string
    readonly assistantMessageId: string
    readonly toolCallId: string
    readonly childSessionId: string
    readonly position: number
    readonly task: string
    readonly modelId: string
    readonly reasoningEffort: TReasoningEffort
    readonly status: TDelegatedTaskStatus
    readonly createdAt: number
    readonly finishedAt?: number
    readonly answer?: string
    readonly error?: string
}
