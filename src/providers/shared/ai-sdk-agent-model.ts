import { isStepCount, jsonSchema, streamText, type JSONSchema7, type LanguageModelUsage, type ToolSet } from "ai"
import type { IAgentModelRequest, IModelUsage, TAgentModelEvent } from "@/agent"

type SdkOptions = Parameters<typeof streamText<ToolSet>>[0]
export type IAiSdkPreparedTurn = Pick<SdkOptions, "model" | "system" | "providerOptions"> & {
    readonly messages: NonNullable<SdkOptions["messages"]>
    readonly normalizeError: (error: unknown) => unknown
    readonly toolCallReasoning: { readonly mode: "not-required" } | {
        readonly mode: "require-nonempty"
        readonly reason: string
    }
}
type ToolCallEvent = Extract<TAgentModelEvent, { type: "tool-call" }>

export async function* streamAiSdkTurn(
    request: IAgentModelRequest,
    prepared: IAiSdkPreparedTurn,
): AsyncIterable<TAgentModelEvent> {
    request.signal.throwIfAborted()
    const tools: ToolSet = {}
    for (const descriptor of request.tools) {
        if (Object.hasOwn(tools, descriptor.name)) throw new Error("Duplicate tool name")
        Object.defineProperty(tools, descriptor.name, {
            enumerable: true,
            value: {
                description: descriptor.description,
                inputSchema: jsonSchema<Record<string, unknown>>(descriptor.inputSchema as JSONSchema7),
            },
        })
    }
    const calls: ToolCallEvent[] = []
    const ids = new Set<string>()
    let reasoningLength = 0
    try {
        const result = streamText({
            model: prepared.model, messages: prepared.messages, tools,
            ...(prepared.system === undefined ? {} : { system: prepared.system }),
            ...(prepared.providerOptions === undefined ? {} : { providerOptions: prepared.providerOptions }),
            abortSignal: request.signal, maxRetries: 0, stopWhen: isStepCount(1), onError: () => {},
        })
        for await (const event of result.stream) {
            if (event.type === "abort") {
                yield { type: "abort", ...(event.reason ? { reason: event.reason } : {}) }
                return
            }
            request.signal.throwIfAborted()
            switch (event.type) {
                case "text-start": case "text-end": case "reasoning-start": case "reasoning-end":
                    yield { type: event.type, id: event.id }
                    break
                case "text-delta":
                    yield { type: "text-delta", id: event.id, delta: event.text }
                    break
                case "reasoning-delta":
                    reasoningLength += event.text.length
                    yield { type: "reasoning-delta", id: event.id, delta: event.text }
                    break
                case "tool-call":
                    if (!event.toolCallId || ids.has(event.toolCallId) || !Object.hasOwn(tools, event.toolName)) throw new Error("Invalid or duplicate tool call")
                    if (!event.input || typeof event.input !== "object" || Array.isArray(event.input)) throw new Error("Tool input must be an object")
                    ids.add(event.toolCallId)
                    calls.push({ type: "tool-call", toolCallId: event.toolCallId, toolName: event.toolName, input: structuredClone(event.input as Record<string, unknown>) })
                    break
                case "finish": {
                    if (calls.length && reasoningLength === 0 && prepared.toolCallReasoning.mode === "require-nonempty") {
                        yield { type: "error", error: new Error(prepared.toolCallReasoning.reason) }
                        return
                    }
                    if (event.finishReason === "tool-calls") {
                        if (!calls.length) throw new Error("Tool-call finish without tool calls")
                        for (const call of calls) {
                            request.signal.throwIfAborted()
                            yield call
                        }
                    } else if (calls.length && event.finishReason !== "length") {
                        throw new Error("Unexpected tool finish reason")
                    }
                    const usage = toModelUsage(event.totalUsage)
                    yield { type: "finish", reason: event.finishReason, ...(usage ? { usage } : {}) }
                    return
                }
                case "error":
                    yield { type: "error", error: prepared.normalizeError(event.error) }
                    return
            }
        }
        throw new Error("Model stream ended without a terminal event")
    } catch (error) {
        if (request.signal.aborted) {
            yield { type: "abort", ...(request.signal.reason ? { reason: String(request.signal.reason) } : {}) }
            return
        }
        throw prepared.normalizeError(error)
    }
}

function toModelUsage(usage: LanguageModelUsage): IModelUsage | undefined {
    const values: IModelUsage = {
        ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
        ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
        ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
        ...(usage.inputTokenDetails.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.inputTokenDetails.cacheReadTokens }),
        ...(usage.inputTokenDetails.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens }),
        ...(usage.outputTokenDetails.reasoningTokens === undefined ? {} : { reasoningTokens: usage.outputTokenDetails.reasoningTokens }),
    }
    return Object.keys(values).length ? values : undefined
}
