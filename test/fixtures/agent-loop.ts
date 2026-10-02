import {
    runAgentLoop,
    type IAgentContext,
    type IAgentContextProjection,
    type IAgentLoopConfig,
    type IAgentLoopResult,
    type IUserMessage,
} from "@/agent"
import { AgentWorkingContext } from "@/sessions/agent-working-context"

/** Test-only owner: accept each completed message after the supplied sink succeeds. */
export function runAgentLoopWithContext(
    prompt: IUserMessage,
    context: Omit<IAgentContext, "getContext" | "getRecentConversation"> & Partial<Pick<IAgentContext, "getRecentConversation">> & IAgentContextProjection,
    config: IAgentLoopConfig,
): Promise<IAgentLoopResult> {
    const { messages, contextSummary, ...configuration } = context
    const owner = new AgentWorkingContext({
        messages,
        ...(contextSummary === undefined ? {} : { contextSummary }),
    })
    return runAgentLoop(prompt, {
        ...configuration,
        getContext: owner.getContext,
        getRecentConversation: context.getRecentConversation ?? (() => owner.getContext().messages),
    }, {
        ...config,
        emit: async (event) => {
            await config.emit(event)
            if (event.type === "message_end") owner.acceptCommittedMessage(event.message)
        },
    })
}
