import { Buffer } from "node:buffer"

import type {
    TAgentMessage,
    IAgentToolDescriptor,
    IModelProfile,
} from "@/agent"

/** Context usage at or above this ratio is eligible for compaction. */
export const CONTEXT_COMPACTION_THRESHOLD = 0.8

/** Conservative UTF-8 approximation used instead of a provider tokenizer. */
export const ESTIMATED_BYTES_PER_TOKEN = 2
export const ESTIMATED_IMAGE_TOKENS = 2_000

export interface IContextEstimationPolicy {
    readonly reasoningHistory: "omit" | "preserve"
    readonly outputReserveTokens?: number
}

const DEFAULT_ESTIMATION_POLICY: IContextEstimationPolicy = {
    reasoningHistory: "omit",
}

/** Provider-visible inputs used by the context estimate. */
export interface IContextInput {
    readonly systemPrompt: string
    readonly contextSummary?: string
    readonly messages: readonly TAgentMessage[]
    readonly tools: readonly IAgentToolDescriptor[]
    readonly modelProfile?: IModelProfile
    readonly estimationPolicy?: IContextEstimationPolicy
}

/** Estimated request usage, compaction safety input, and any known model limit. */
export interface IContextUsage {
    readonly estimatedInputTokens: number
    /** Safety-adjusted input compared with the threshold, not raw provider usage. */
    readonly compactionInputTokens: number
    readonly contextWindowTokens?: number
    readonly compactionThresholdTokens?: number
    readonly remainingTokens?: number
    readonly usageRatio?: number
    readonly shouldCompact: boolean
}

/**
 * Serializes a provider-visible projection and treats every two UTF-8 bytes
 * as one token. This is intentionally conservative, not a model tokenizer.
 */
export function estimateContextInputTokens(input: IContextInput): number {
    return estimateSerializedTokens({
        systemPrompt: input.systemPrompt,
        ...(input.contextSummary ? { contextSummary: input.contextSummary } : {}),
        messages: providerVisibleMessages(input.messages, input.estimationPolicy ?? DEFAULT_ESTIMATION_POLICY),
        tools: input.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
        })),
    }) + estimatedImageTokens(input.messages)
}

/** Estimates only the serialized message portion of a provider request. */
export function estimateMessagesInputTokens(
    messages: readonly TAgentMessage[],
    policy: IContextEstimationPolicy = DEFAULT_ESTIMATION_POLICY,
): number {
    return estimateSerializedTokens(providerVisibleMessages(messages, policy))
        + estimatedImageTokens(messages)
}

function estimatedImageTokens(messages: readonly TAgentMessage[]): number {
    return messages.reduce((total, message) => total + (
        message.role === "user"
            ? (message.attachments?.length ?? 0) * ESTIMATED_IMAGE_TOKENS
            : 0
    ), 0)
}

/** Caps the usual 80% threshold by any explicit output reserve. */
export function contextCompactionThresholdTokens(
    contextWindowTokens: number,
    policy?: IContextEstimationPolicy,
): number {
    assertPositiveTokenCount(contextWindowTokens, "contextWindowTokens")
    const reserve = policy?.outputReserveTokens
    if (reserve !== undefined) {
        assertPositiveTokenCount(reserve, "outputReserveTokens")
        if (reserve >= contextWindowTokens) {
            throw new Error("outputReserveTokens must be smaller than contextWindowTokens")
        }
    }
    return Math.min(
        Math.ceil(contextWindowTokens * CONTEXT_COMPACTION_THRESHOLD),
        contextWindowTokens - (reserve ?? 0),
    )
}

/** Reports whether an estimated input has reached the 80% threshold. */
export function shouldCompactContext(
    estimatedInputTokens: number,
    contextWindowTokens?: number,
    policy?: IContextEstimationPolicy,
): boolean {
    assertNonNegativeTokenCount(estimatedInputTokens, "estimatedInputTokens")
    if (contextWindowTokens === undefined) return false
    return estimatedInputTokens
        >= contextCompactionThresholdTokens(contextWindowTokens, policy)
}

/** Estimates provider input and relates it to an optional model context limit. */
export function estimateContextUsage(
    input: IContextInput,
    contextWindowTokens?: number,
): IContextUsage {
    const reportedInputTokens = reportedInputSafetyTokens(input)
    const estimatedInputTokens = Math.max(
        estimateContextInputTokens(input),
        reportedInputTokens,
    )
    // Without a provider usage anchor, retain the byte-level safety multiplier
    // to guard against tokenizer underestimates. Expose this existing bound
    // separately so callers can explain compaction without changing its policy.
    const compactionInputTokens = reportedInputTokens > 0
        ? estimatedInputTokens
        : estimatedInputTokens * ESTIMATED_BYTES_PER_TOKEN
    if (contextWindowTokens === undefined) {
        return { estimatedInputTokens, compactionInputTokens, shouldCompact: false }
    }

    const compactionThresholdTokens = contextCompactionThresholdTokens(
        contextWindowTokens,
        input.estimationPolicy,
    )
    return {
        estimatedInputTokens,
        compactionInputTokens,
        contextWindowTokens,
        compactionThresholdTokens,
        remainingTokens: Math.max(0, contextWindowTokens - estimatedInputTokens),
        usageRatio: estimatedInputTokens / contextWindowTokens,
        shouldCompact: compactionInputTokens >= compactionThresholdTokens,
    }
}

/** Adds a byte-level bound for the current fixed prefix to retained usage. */
export function reportedInputSafetyTokens(input: IContextInput): number {
    const reportedTokens = reportedInputTokenFloor(
        input.messages,
        input.modelProfile,
        input.estimationPolicy,
    )
    if (reportedTokens === 0) return 0
    return reportedTokens + estimateContextInputTokens({
        systemPrompt: input.systemPrompt,
        ...(input.contextSummary === undefined
            ? {}
            : { contextSummary: input.contextSummary }),
        messages: [],
        tools: input.tools,
        ...(input.estimationPolicy === undefined ? {} : { estimationPolicy: input.estimationPolicy }),
    }) * ESTIMATED_BYTES_PER_TOKEN
}

/** Anchors at provider usage and adds a byte-level bound for everything appended. */
export function reportedInputTokenFloor(
    messages: readonly TAgentMessage[],
    modelProfile?: IModelProfile,
    policy: IContextEstimationPolicy = DEFAULT_ESTIMATION_POLICY,
): number {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (
            message?.role === "assistant"
            && message.stopReason !== "error"
            && message.stopReason !== "aborted"
            && message.usage?.inputTokens !== undefined
            && (modelProfile === undefined || (
                message.model?.providerId === modelProfile.providerId
                && message.model.modelId === modelProfile.modelId
            ))
        ) {
            // Provider inputTokens already includes cache reads and writes;
            // adding those detail counters again would inflate the anchor.
            return message.usage.inputTokens
                + estimateMessagesInputTokens(messages.slice(index), policy)
                    * ESTIMATED_BYTES_PER_TOKEN
        }
    }
    return 0
}

function providerVisibleMessages(
    messages: readonly TAgentMessage[],
    policy: IContextEstimationPolicy,
): readonly unknown[] {
    return messages.flatMap((message): readonly unknown[] => {
        switch (message.role) {
            case "user":
                return [{ role: "user", content: message.content }]
            case "assistant": {
                if (
                    message.stopReason === "error"
                    || message.stopReason === "aborted"
                ) {
                    return []
                }
                const content = message.content.flatMap((item): readonly unknown[] => {
                    switch (item.type) {
                        case "text":
                            return [{ type: "text", text: item.text }]
                        case "reasoning":
                            return policy.reasoningHistory === "preserve"
                                ? [{ type: "reasoning", text: item.text }]
                                : []
                        case "toolCall":
                            return [{
                                type: "tool-call",
                                toolCallId: item.toolCallId,
                                toolName: item.toolName,
                                input: item.input,
                            }]
                    }
                })
                return content.length === 0
                    ? []
                    : [{ role: "assistant", content }]
            }
            case "toolResult":
                return [{
                    role: "tool",
                    content: [{
                        type: "tool-result",
                        toolCallId: message.toolCallId,
                        toolName: message.toolName,
                        output: message.isError
                            ? { type: "error-text", value: message.content }
                            : { type: "text", value: message.content },
                    }],
                }]
        }
    })
}

function estimateSerializedTokens(value: unknown): number {
    return Math.ceil(
        Buffer.byteLength(JSON.stringify(value), "utf8")
            / ESTIMATED_BYTES_PER_TOKEN,
    )
}

function assertPositiveTokenCount(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive integer`)
    }
}

function assertNonNegativeTokenCount(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative integer`)
    }
}
