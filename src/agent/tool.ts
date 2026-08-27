import type {
    ToolApprovalDecision,
    ToolApprovalDraft,
} from "@/agent/tool-approval"
import type {
    AgentMessage,
    UserPathReference,
} from "@/agent/messages"
import type { ModelProfile } from "@/agent/model-values"
import type { Static, TSchema } from "typebox"

export type ToolApprovalKind = ToolApprovalDraft["kind"]

/** Final outcome of a local tool execution stored in conversation history. */
export type ToolExecutionOutcome =
    | "completed"
    | "rejected"
    | "manual"
    | "failed"
    | "committed-after-abort"
    | "effects-unknown"

/** Model-visible tool definition without local execution code. */
export interface AgentToolDescriptor<
    TInputSchema extends TSchema = TSchema,
> {
    readonly name: string
    readonly description: string
    readonly inputSchema: TInputSchema
}

/** Host-owned context supplied to one local tool invocation. */
export interface AgentToolContext {
    readonly sessionId: string
    readonly toolCallId: string
    readonly runId: string
    readonly modelProfile?: ModelProfile
    readonly providerAccountId?: string
    readonly messages?: readonly AgentMessage[]
    readonly selectedPathReferences?: readonly UserPathReference[]
    readonly signal: AbortSignal
    readonly reportProgress?: (progress: string) => void
    readonly requestApproval?: (
        draft: ToolApprovalDraft,
    ) => Promise<ToolApprovalDecision>
}

export interface AgentToolResult {
    readonly content: string
    readonly outcome?: ToolExecutionOutcome
    readonly summary?: string
}

/** Executable host tool paired with the descriptor exposed to a model. */
export interface AgentTool<
    // `any` is the schema-erased form used by heterogeneous tool registries.
    TInputSchema extends TSchema = any,
> extends AgentToolDescriptor<TInputSchema> {
    readonly approvalKind?: ToolApprovalKind
    readonly requiresConversationContext?: boolean
    readonly acceptsSelectedPathReferences?: boolean
    readonly execute: {
        bivarianceHack(
            input: TSchema extends TInputSchema
                ? Record<string, unknown>
                : Static<TInputSchema>,
            context: AgentToolContext,
        ): Promise<string | AgentToolResult>
    }["bivarianceHack"]
}
