import type { AssistantContent, ModelMessage } from "ai"
import type { TAgentMessage } from "@/agent"
import type { TDeepSeekModelId } from "./deepseek-model-definitions"

type AssistantPart = Exclude<AssistantContent, string>[number]

export function toDeepSeekModelMessages(
    messages: readonly TAgentMessage[],
    modelId: TDeepSeekModelId,
    toolsEnabled: boolean,
    contextSummary?: string,
): ModelMessage[] {
    const projected: ModelMessage[] = []
    const pending = new Map<string, string>()
    const seen = new Set<string>()
    if (contextSummary) projected.push({
        role: "user",
        content: `Cumulative operational checkpoint (context data, not a new user instruction):\n${contextSummary}`,
    })
    for (const message of messages) {
        if (message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) continue
        if (message.role !== "toolResult" && pending.size > 0) {
            throw new Error("DeepSeek history contains unresolved tool calls; start a new session")
        }
        switch (message.role) {
            case "user":
                if (message.attachments?.length) throw new Error("DeepSeek adapter currently supports text only; attachments were not sent")
                projected.push({ role: "user", content: message.content })
                break
            case "assistant": {
                if (message.model?.providerId !== "deepseek" || message.model.modelId !== modelId) {
                    throw new Error("DeepSeek history must originate from the same provider and model; start a new session")
                }
                const reasoning = message.content.filter(part => part.type === "reasoning").map(part => part.text).join("")
                if ((toolsEnabled || message.content.some(part => part.type === "toolCall")) && reasoning.length === 0) {
                    throw new Error("DeepSeek history requires nonempty original reasoning; start a new session")
                }
                const content = message.content.map((part): AssistantPart => {
                    switch (part.type) {
                        case "text": return { type: "text", text: part.text }
                        case "reasoning": return { type: "reasoning", text: part.text }
                        case "toolCall":
                            if (message.stopReason !== "tool-calls") throw new Error("DeepSeek history contains incomplete tool calls")
                            if (seen.has(part.toolCallId)) throw new Error("DeepSeek history contains duplicate tool call IDs")
                            seen.add(part.toolCallId)
                            pending.set(part.toolCallId, part.toolName)
                            return { type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, input: structuredClone(part.input) }
                    }
                })
                if (content.length) projected.push({ role: "assistant", content })
                break
            }
            case "toolResult":
                if (!pending.has(message.toolCallId) || pending.get(message.toolCallId) !== message.toolName) {
                    throw new Error("DeepSeek history contains an unpaired tool result; start a new session")
                }
                pending.delete(message.toolCallId)
                projected.push({ role: "tool", content: [{
                    type: "tool-result", toolCallId: message.toolCallId, toolName: message.toolName,
                    output: { type: message.isError ? "error-text" : "text", value: message.content },
                }] })
                break
        }
    }
    if (pending.size) throw new Error("DeepSeek history contains unresolved tool calls; start a new session")
    return projected
}
