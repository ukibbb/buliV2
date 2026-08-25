import {
    type IAgentModel,
    type IAgentModelEvent,
    type IAgentModelRequest,
    isModelContextOverflowError,
} from "@/agent"
import {
    contextCompactionThresholdTokens,
    estimateContextInputTokens,
    estimateContextUsage,
    estimateMessagesInputTokens,
    type IContextUsage,
} from "@/sessions/compaction/context-budget"
import {
    retainedContextTargetTokens,
} from "@/sessions/compaction/session-compactor"

export const CONTEXT_SUMMARY_RESERVE_TOKENS = 2_048

export interface IContextAwareModelOptions {
    readonly model: IAgentModel
    readonly contextWindowTokens: number | undefined
    readonly projectRequest: (
        originalRequest: IAgentModelRequest,
    ) => IAgentModelRequest
    readonly compactAndReproject: (
        originalRequest: IAgentModelRequest,
        requestBudgetTokens: number,
    ) => Promise<IAgentModelRequest | undefined>
    readonly publishContextUsage: (usage: IContextUsage) => void
}

/** Adds just-in-time compaction and one safe overflow retry to a conversation model. */
export function createContextAwareModel(
    options: IContextAwareModelOptions,
): IAgentModel {
    return {
        async *stream(originalRequest) {
            originalRequest.signal.throwIfAborted()

            let request = options.projectRequest(originalRequest)
            const contextWindowTokens = options.contextWindowTokens
            const initialUsage = estimateRequestUsage(
                request,
                contextWindowTokens,
            )
            options.publishContextUsage(initialUsage)

            if (initialUsage.shouldCompact && contextWindowTokens !== undefined) {
                const compactedRequest = await options.compactAndReproject(
                    originalRequest,
                    retainedMessageAllowanceTokens(
                        request,
                        contextWindowTokens,
                    ),
                )
                if (compactedRequest) {
                    request = compactedRequest
                    options.publishContextUsage(estimateRequestUsage(
                        request,
                        contextWindowTokens,
                    ))
                }
            }

            let retriedOverflow = false
            let exposedSemanticEvent = false

            for (;;) {
                request.signal.throwIfAborted()
                let interceptedOverflow:
                    | { readonly kind: "emitted"; readonly event: IAgentModelEvent }
                    | { readonly kind: "thrown"; readonly error: unknown }
                    | undefined

                try {
                    for await (const event of options.model.stream(request)) {
                        if (event.type === "error") {
                            if (
                                !retriedOverflow
                                && !exposedSemanticEvent
                                && isModelContextOverflowError(event.error)
                            ) {
                                interceptedOverflow = {
                                    kind: "emitted",
                                    event,
                                }
                                break
                            }
                            yield event
                            return
                        }

                        if (isSemanticModelEvent(event)) {
                            exposedSemanticEvent = true
                        }
                        yield event
                    }
                } catch (error) {
                    if (
                        !retriedOverflow
                        && !exposedSemanticEvent
                        && isModelContextOverflowError(error)
                    ) {
                        interceptedOverflow = { kind: "thrown", error }
                    } else {
                        throw error
                    }
                }

                if (!interceptedOverflow) return

                retriedOverflow = true
                originalRequest.signal.throwIfAborted()
                const retryRequest = await options.compactAndReproject(
                    originalRequest,
                    0,
                )
                if (!retryRequest) {
                    if (interceptedOverflow.kind === "emitted") {
                        yield interceptedOverflow.event
                        return
                    }
                    throw interceptedOverflow.error
                }

                request = retryRequest
                options.publishContextUsage(estimateRequestUsage(
                    request,
                    contextWindowTokens,
                ))
            }
        },
    }
}

/** Computes a whole-turn retained-message target within the compactor's 20k cap. */
export function retainedMessageAllowanceTokens(
    request: IAgentModelRequest,
    contextWindowTokens: number,
): number {
    const latestUserIndex = request.messages.findLastIndex(
        (message) => message.role === "user",
    )
    const latestTurnTokens = latestUserIndex === -1
        ? 0
        : estimateMessagesInputTokens(request.messages.slice(latestUserIndex))
    const fixedRequestTokens = estimateContextInputTokens({
        systemPrompt: request.systemPrompt,
        messages: [],
        tools: request.tools,
    })
    const additionalRetainedTokens = Math.max(
        0,
        contextCompactionThresholdTokens(contextWindowTokens)
            - fixedRequestTokens
            - CONTEXT_SUMMARY_RESERVE_TOKENS
            - latestTurnTokens,
    )
    return retainedContextTargetTokens(
        latestTurnTokens + additionalRetainedTokens,
    )
}

function estimateRequestUsage(
    request: IAgentModelRequest,
    contextWindowTokens: number | undefined,
): IContextUsage {
    return estimateContextUsage({
        systemPrompt: request.systemPrompt,
        ...(request.contextSummary === undefined
            ? {}
            : { contextSummary: request.contextSummary }),
        messages: request.messages,
        tools: request.tools,
    }, contextWindowTokens)
}

function isSemanticModelEvent(event: IAgentModelEvent): boolean {
    return event.type === "text-start"
        || event.type === "text-delta"
        || event.type === "text-end"
        || event.type === "reasoning-start"
        || event.type === "reasoning-delta"
        || event.type === "reasoning-end"
        || event.type === "tool-call"
}
