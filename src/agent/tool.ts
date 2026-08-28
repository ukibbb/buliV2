import type {
    TToolApprovalDecision,
    TToolApprovalDraft,
} from "@/agent/tool-approval"
import type {
    TAgentMessage,
    IUserPathReference,
} from "@/agent/messages"
import type { IModelProfile } from "@/agent/model-values"
import type { Static, TSchema } from "typebox"

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
export interface IAgentToolDescriptor<
    TInputSchema extends TSchema = TSchema,
> {
    readonly name: string
    readonly description: string
    readonly inputSchema: TInputSchema
}

/** Host-owned context supplied to one local tool invocation. */
export interface IAgentToolContext {
    readonly sessionId: string
    readonly toolCallId: string
    readonly runId: string
    readonly modelProfile?: IModelProfile
    readonly providerAccountId?: string
    readonly messages?: readonly TAgentMessage[]
    readonly selectedPathReferences?: readonly IUserPathReference[]
    readonly signal: AbortSignal
    readonly reportProgress?: (progress: string) => void
    readonly requestApproval?: (
        draft: TToolApprovalDraft,
    ) => Promise<TToolApprovalDecision>
}

export interface IAgentToolResult {
    readonly content: string
    readonly outcome?: TToolExecutionOutcome
    readonly summary?: string
}

/** Executable host tool paired with the descriptor exposed to a model. */
export interface IAgentTool<
    // `any` is the schema-erased form used by heterogeneous tool registries.
    TInputSchema extends TSchema = any,
> extends IAgentToolDescriptor<TInputSchema> {
    readonly approvalKind?: TToolApprovalKind
    readonly prepareArguments?: (input: unknown) => unknown
    readonly selfTruncatesOutput?: boolean
    readonly requiresConversationContext?: boolean
    readonly acceptsSelectedPathReferences?: boolean
    readonly execute: {
        bivarianceHack(
            input: TSchema extends TInputSchema
                ? Record<string, unknown>
                : Static<TInputSchema>,
            context: IAgentToolContext,
        ): Promise<string | IAgentToolResult>
    }["bivarianceHack"]
}
