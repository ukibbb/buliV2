import type {
    IToolCallContent,
    IToolResultMessage,
    IUserMessage,
} from "@/agent/messages/messages"

/** What hooks decided for one prompt or tool call: block it, or add context the model sees. */
export interface IHookDecision {
    readonly blockReason?: string
    readonly context?: string
}

/** Session hooks around user prompts and local tool calls; implementations never throw. */
export interface IAgentHooks {
    beforePrompt(message: IUserMessage, signal: AbortSignal): Promise<IHookDecision>
    beforeTool(call: IToolCallContent, signal: AbortSignal): Promise<IHookDecision>
    /** Returns context for the model about the completed call; the executor joins it after `beforeTool` context. */
    afterTool(call: IToolCallContent, result: IToolResultMessage, signal: AbortSignal): Promise<string | undefined>
}
