import type {
    IToolCallContent,
    IToolResultMessage,
    IUserMessage,
    TAgentMessage,
} from "@/agent/messages/messages"

/** What hooks decided for one prompt or tool call: block it, or add context the model sees. */
export interface IHookDecision {
    readonly blockReason?: string
    readonly context?: string
}

/** Session hooks around prompts, tool calls, finished runs and the session's end; implementations never throw. */
export interface IAgentHooks {
    beforePrompt(message: IUserMessage, signal: AbortSignal): Promise<IHookDecision>
    beforeTool(call: IToolCallContent, signal: AbortSignal): Promise<IHookDecision>
    /** Returns context for the model about the completed call; the executor joins it after `beforeTool` context. */
    afterTool(call: IToolCallContent, result: IToolResultMessage, signal: AbortSignal): Promise<string | undefined>
    /** A message reached durable history. */
    afterMessage(message: TAgentMessage): void
    /** A run completed; work happens in the background so the next prompt is not delayed. */
    afterRun(): void
    /** The session is closing; resolves when its hooks have finished. */
    endSession(): Promise<void>
}
