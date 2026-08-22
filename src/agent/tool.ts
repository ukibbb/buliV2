import type {
    TToolApprovalDecision,
    TToolApprovalDraft,
} from "@/agent/tool-approval"

export type TToolApprovalKind = TToolApprovalDraft["kind"]

/** Final outcome of a local tool execution stored in conversation history. */
export type TToolExecutionOutcome =
    | "completed"
    | "rejected"
    | "manual"
    | "failed"
    | "committed-after-abort"
    | "effects-unknown"

/** Model-visible tool definition without local execution code. */
export interface IAgentToolDescriptor {
    readonly name: string
    readonly description: string
    readonly inputSchema: Record<string, unknown>
}

/** Host-owned context supplied to one local tool invocation. */
export interface IAgentToolExecutionContext {
    readonly toolCallId: string
    readonly runId: string
    readonly signal: AbortSignal
    readonly reportProgress?: (progress: string) => void
    readonly requestApproval?: (
        draft: TToolApprovalDraft,
    ) => Promise<TToolApprovalDecision>
}

export interface IAgentToolExecutionResult {
    readonly content: string
    readonly outcome?: TToolExecutionOutcome
    readonly summary?: string
}

/** Executable host tool paired with the descriptor exposed to a model. */
export interface IAgentTool extends IAgentToolDescriptor {
    readonly approvalKind?: TToolApprovalKind
    readonly execute: (
        input: Record<string, unknown>,
        context: IAgentToolExecutionContext,
    ) => Promise<string | IAgentToolExecutionResult>
}
