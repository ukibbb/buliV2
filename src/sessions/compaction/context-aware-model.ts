import {
    type AgentModel,
    type AgentModelEvent,
    type AgentModelRequest,
    type ModelProfile,
    isModelContextOverflowError,
} from "@/agent"
import {
    contextCompactionThresholdTokens,
    ESTIMATED_BYTES_PER_TOKEN,
    estimateContextInputTokens,
    estimateContextUsage,
    reportedInputSafetyTokens,
    type IContextUsage,
} from "@/sessions/compaction/context-budget"
import {
    retainedContextTargetTokens,
} from "@/sessions/compaction/session-compactor"

export const CONTEXT_SUMMARY_RESERVE_TOKENS = 2_048
const MAX_COMPACTION_PASSES = 64

export interface IContextAwareModelOptions {
    readonly model: AgentModel
    readonly modelProfile?: ModelProfile
    readonly contextWindowTokens: number | undefined
    readonly projectRequest: (
        originalRequest: AgentModelRequest,
    ) => AgentModelRequest
    readonly compactAndReproject: (
        originalRequest: AgentModelRequest,
        requestBudgetTokens: number,
    ) => Promise<AgentModelRequest | undefined>
    readonly publishContextUsage: (usage: IContextUsage) => void
}

/** Adds bounded preflight compaction and one safe overflow retry to a model. */
export function createContextAwareModel(
    options: IContextAwareModelOptions,
): AgentModel {
    return {
        async *stream(originalRequest) {
            originalRequest.signal.throwIfAborted()

            let request = await compactPreflightRequest(
                options,
                originalRequest,
                options.projectRequest(originalRequest),
            )

            let retriedOverflow = false
            let exposedSemanticEvent = false

            for (;;) {
                request.signal.throwIfAborted()
                let interceptedOverflow:
                    | { readonly kind: "emitted"; readonly event: AgentModelEvent }
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
                const retryRequest = await compactOverflowRequest(
                    options,
                    originalRequest,
                )
                if (!retryRequest) {
                    if (interceptedOverflow.kind === "emitted") {
                        yield interceptedOverflow.event
                        return
                    }
                    throw interceptedOverflow.error
                }

                request = retryRequest
            }
        },
    }
}

async function compactPreflightRequest(
    options: IContextAwareModelOptions,
    originalRequest: AgentModelRequest,
    initialRequest: AgentModelRequest,
): Promise<AgentModelRequest> {
    let request = initialRequest
    for (let pass = 0; pass <= MAX_COMPACTION_PASSES; pass += 1) {
        originalRequest.signal.throwIfAborted()
        const usage = estimateRequestUsage(
            request,
            options.contextWindowTokens,
            options.modelProfile,
        )
        options.publishContextUsage(usage)
        if (!usage.shouldCompact || options.contextWindowTokens === undefined) {
            return request
        }
        if (pass === MAX_COMPACTION_PASSES) throw requestBudgetError(usage)

        const compactedRequest = await options.compactAndReproject(
            originalRequest,
            retainedMessageAllowanceTokens(
                request,
                options.contextWindowTokens,
                options.modelProfile,
            ),
        )
        if (!compactedRequest) throw requestBudgetError(usage)
        request = compactedRequest
    }
    throw new Error("Unreachable context compaction state")
}

async function compactOverflowRequest(
    options: IContextAwareModelOptions,
    originalRequest: AgentModelRequest,
): Promise<AgentModelRequest | undefined> {
    let request = await options.compactAndReproject(originalRequest, 0)
    if (!request) return undefined

    for (let pass = 0; pass < MAX_COMPACTION_PASSES; pass += 1) {
        originalRequest.signal.throwIfAborted()
        const usage = estimateRequestUsage(
            request,
            options.contextWindowTokens,
            options.modelProfile,
        )
        options.publishContextUsage(usage)
        if (!usage.shouldCompact || options.contextWindowTokens === undefined) {
            return request
        }
        request = await options.compactAndReproject(originalRequest, 0)
        if (!request) return undefined
    }
    return undefined
}

function requestBudgetError(usage: IContextUsage): Error {
    const threshold = usage.compactionThresholdTokens
    return new Error(
        "Model request remains above Buli's safe context budget after compaction"
        + `${threshold === undefined
            ? ""
            : ` (${usage.estimatedInputTokens} estimated tokens; safe limit ${threshold})`}`
        + "; no provider request was sent.",
    )
}

/** Computes the retained-message target within the request and policy caps. */
export function retainedMessageAllowanceTokens(
    request: AgentModelRequest,
    contextWindowTokens: number,
    modelProfile?: ModelProfile,
): number {
    const thresholdTokens = contextCompactionThresholdTokens(contextWindowTokens)
    const contextInput = {
        systemPrompt: request.systemPrompt,
        ...(request.contextSummary === undefined
            ? {}
            : { contextSummary: request.contextSummary }),
        messages: request.messages,
        tools: request.tools,
        ...(modelProfile === undefined ? {} : { modelProfile }),
    }
    const reportedInputTokens = reportedInputSafetyTokens(contextInput)
    if (reportedInputTokens >= thresholdTokens) return 0

    const fixedRequestTokens = estimateContextInputTokens({
        systemPrompt: request.systemPrompt,
        messages: [],
        tools: request.tools,
    })
    const summaryTokens = request.contextSummary === undefined
        ? 0
        : estimateContextInputTokens({
            systemPrompt: request.systemPrompt,
            contextSummary: request.contextSummary,
            messages: [],
            tools: request.tools,
        }) - fixedRequestTokens
    const summaryReserveTokens = Math.max(
        CONTEXT_SUMMARY_RESERVE_TOKENS,
        summaryTokens,
    )
    const retainedTokens = Math.max(
        0,
        thresholdTokens
            - fixedRequestTokens
            - summaryReserveTokens,
    )
    if (reportedInputTokens > 0) {
        return retainedContextTargetTokens(retainedTokens)
    }

    const byteBoundedRetainedTokens = Math.floor(Math.max(
        0,
        thresholdTokens
            - fixedRequestTokens * ESTIMATED_BYTES_PER_TOKEN
            - Math.max(
                CONTEXT_SUMMARY_RESERVE_TOKENS,
                summaryTokens * ESTIMATED_BYTES_PER_TOKEN,
            ),
    ) / ESTIMATED_BYTES_PER_TOKEN)
    return retainedContextTargetTokens(Math.min(
        retainedTokens,
        byteBoundedRetainedTokens,
    ))
}

function estimateRequestUsage(
    request: AgentModelRequest,
    contextWindowTokens: number | undefined,
    modelProfile?: ModelProfile,
): IContextUsage {
    return estimateContextUsage({
        systemPrompt: request.systemPrompt,
        ...(request.contextSummary === undefined
            ? {}
            : { contextSummary: request.contextSummary }),
        messages: request.messages,
        tools: request.tools,
        ...(modelProfile === undefined ? {} : { modelProfile }),
    }, contextWindowTokens)
}

function isSemanticModelEvent(event: AgentModelEvent): boolean {
    return event.type === "text-start"
        || event.type === "text-delta"
        || event.type === "text-end"
        || event.type === "reasoning-start"
        || event.type === "reasoning-delta"
        || event.type === "reasoning-end"
        || event.type === "tool-call"
}
