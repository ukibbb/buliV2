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
import { Value } from "typebox/value"

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
    TName extends string = string,
> {
    readonly name: TName
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

interface IAgentToolOptions {
    readonly approvalKind?: TToolApprovalKind
    readonly prepareArguments?: (input: unknown) => unknown
    readonly selfTruncatesOutput?: boolean
    readonly requiresConversationContext?: boolean
    readonly acceptsSelectedPathReferences?: boolean
}

/** A tool definition whose executor input is derived from its exact schema. */
interface IAgentToolDefinition<
    TInputSchema extends TSchema,
    TName extends string,
> extends IAgentToolDescriptor<TInputSchema, TName>, IAgentToolOptions {
    readonly execute: (
        input: Static<TInputSchema>,
        context: IAgentToolContext,
    ) => Promise<string | IAgentToolResult>
}

/** A tool that safely crosses the heterogeneous runtime execution boundary. */
export interface IRuntimeAgentTool
    extends IAgentToolDescriptor, IAgentToolOptions {
    readonly validateAndExecute: (
        unvalidatedInput: unknown,
        context: IAgentToolContext,
    ) => Promise<string | IAgentToolResult>
}

/** A strictly defined tool together with its safe runtime executor. */
export type IAgentTool<
    TInputSchema extends TSchema,
    TName extends string = string,
> = IAgentToolDefinition<TInputSchema, TName> & IRuntimeAgentTool

/** Defines a tool while deriving its executor input from its exact schema. */
export function defineAgentTool<
    const TInputSchema extends TSchema,
    const TName extends string,
>(
    definition: IAgentToolDefinition<TInputSchema, TName>,
): IAgentTool<TInputSchema, TName> {
    return {
        ...definition,
        async validateAndExecute(unvalidatedInput, context) {
            const convertedInput = Value.Convert(
                definition.inputSchema,
                unvalidatedInput,
            )
            if (!Value.Check(definition.inputSchema, convertedInput)) {
                const details = Value.Errors(
                    definition.inputSchema,
                    convertedInput,
                )
                    .slice(0, 3)
                    .map((error) => `${error.instancePath || "/"}: ${error.message}`)
                    .join("; ")
                throw new TypeError(
                    `Invalid input for tool "${definition.name}": ${details || "schema validation failed"}`,
                )
            }
            return definition.execute(convertedInput, context)
        },
    }
}
