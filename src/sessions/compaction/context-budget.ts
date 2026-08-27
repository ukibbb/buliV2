import { Buffer } from "node:buffer"

import type {
    AgentMessage,
    AgentToolDescriptor,
    ModelProfile,
} from "@/agent"

/** Context usage at or above this ratio is eligible for compaction. */
export const CONTEXT_COMPACTION_THRESHOLD = 0.8

/** Conservative UTF-8 approximation used instead of a provider tokenizer. */
export const ESTIMATED_BYTES_PER_TOKEN = 2
export const ESTIMATED_IMAGE_TOKENS = 2_000

/** Provider-visible inputs used by the context estimate. */
export interface IContextInput {
    readonly systemPrompt: string
    readonly contextSummary?: string
    readonly messages: readonly AgentMessage[]
    readonly tools: readonly AgentToolDescriptor[]
    readonly modelProfile?: ModelProfile
}

/** Estimated request usage plus model-limit information when it is known. */
export interface IContextUsage {
    readonly estimatedInputTokens: number
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
        messages: providerVisibleMessages(input.messages),
        tools: input.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
        })),
    }) + estimatedImageTokens(input.messages)
}

/** Estimates only the serialized message portion of a provider request. */
export function estimateMessagesInputTokens(
    messages: readonly AgentMessage[],
): number {
    return estimateSerializedTokens(providerVisibleMessages(messages))
        + estimatedImageTokens(messages)
}

function estimatedImageTokens(messages: readonly AgentMessage[]): number {
    return messages.reduce((total, message) => total + (
        message.role === "user"
            ? (message.attachments?.length ?? 0) * ESTIMATED_IMAGE_TOKENS
            : 0
    ), 0)
}

/** Returns the first whole-token count at or above 80% of a context window. */
export function contextCompactionThresholdTokens(
    contextWindowTokens: number,
): number {
    assertPositiveTokenCount(contextWindowTokens, "contextWindowTokens")
    return Math.ceil(contextWindowTokens * CONTEXT_COMPACTION_THRESHOLD)
}

/** Reports whether an estimated input has reached the 80% threshold. */
export function shouldCompactContext(
    estimatedInputTokens: number,
    contextWindowTokens?: number,
): boolean {
    assertNonNegativeTokenCount(estimatedInputTokens, "estimatedInputTokens")
    if (contextWindowTokens === undefined) return false
    return estimatedInputTokens
        >= contextCompactionThresholdTokens(contextWindowTokens)
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
    if (contextWindowTokens === undefined) {
        return { estimatedInputTokens, shouldCompact: false }
    }

    const compactionThresholdTokens = contextCompactionThresholdTokens(
        contextWindowTokens,
    )
    const safetyInputTokens = reportedInputTokens > 0
        ? estimatedInputTokens
        : estimatedInputTokens * ESTIMATED_BYTES_PER_TOKEN
    return {
        estimatedInputTokens,
        contextWindowTokens,
        compactionThresholdTokens,
        remainingTokens: Math.max(0, contextWindowTokens - estimatedInputTokens),
        usageRatio: estimatedInputTokens / contextWindowTokens,
        shouldCompact: safetyInputTokens >= compactionThresholdTokens,
    }
}

/** Adds a byte-level bound for the current fixed prefix to retained usage. */
export function reportedInputSafetyTokens(input: IContextInput): number {
    const reportedTokens = reportedInputTokenFloor(
        input.messages,
        input.modelProfile,
    )
    if (reportedTokens === 0) return 0
    return reportedTokens + estimateContextInputTokens({
        systemPrompt: input.systemPrompt,
        ...(input.contextSummary === undefined
            ? {}
            : { contextSummary: input.contextSummary }),
        messages: [],
        tools: input.tools,
    }) * ESTIMATED_BYTES_PER_TOKEN
}

/** Anchors at provider usage and adds a byte-level bound for everything appended. */
export function reportedInputTokenFloor(
    messages: readonly AgentMessage[],
    modelProfile?: ModelProfile,
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
            return message.usage.inputTokens
                + estimateMessagesInputTokens(messages.slice(index))
                    * ESTIMATED_BYTES_PER_TOKEN
        }
    }
    return 0
}

function providerVisibleMessages(
    messages: readonly AgentMessage[],
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
                            // Current OpenAI projection does not resend reasoning.
                            return []
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
