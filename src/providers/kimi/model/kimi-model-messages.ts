import { Buffer } from "node:buffer"
import type { AssistantContent, ModelMessage, ToolContent, UserContent } from "ai"
import type { TAgentMessage } from "@/agent"

type AssistantPart = Exclude<AssistantContent, string>[number]

export function toKimiModelMessages(
    messages: readonly TAgentMessage[],
    modelId: string,
    contextSummary?: string,
): ModelMessage[] {
    const projected: ModelMessage[] = []
    const pending = new Map<string, string>()
    const seen = new Set<string>()
    if (contextSummary) projected.push({
        role: "assistant",
        content: `Cumulative operational checkpoint:\n${contextSummary}`,
    })
    for (const message of messages) {
        if (message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) continue
        if (message.role !== "toolResult" && pending.size > 0) {
            throw new Error("Kimi history contains unresolved tool calls; start a new session")
        }
        switch (message.role) {
            case "user": {
                const content: UserContent = [
                    { type: "text", text: message.content },
                    ...(message.attachments ?? []).map((attachment) => {
                        if (!attachment.mimeType.startsWith("image/") || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(attachment.data) || !attachment.data) {
                            throw new Error("Invalid Kimi image attachment; expected base64 image bytes")
                        }
                        return {
                            type: "file" as const,
                            data: new Uint8Array(Buffer.from(attachment.data, "base64")),
                            mediaType: attachment.mimeType,
                            filename: attachment.filename,
                        }
                    }),
                ]
                projected.push({ role: "user", content })
                break
            }
            case "assistant": {
                if (message.model?.providerId !== "kimi-coding" || message.model.modelId !== modelId) {
                    throw new Error("Kimi history must originate from the same provider and model; start a new session")
                }
                const reasoning = message.content.filter((part) => part.type === "reasoning")
                    .map((part) => part.text).join("")
                const content = message.content.map((part): AssistantPart => {
                    switch (part.type) {
                        case "text": return { type: "text", text: part.text }
                        case "reasoning": return { type: "reasoning", text: part.text }
                        case "toolCall": {
                            if (reasoning.length === 0) throw new Error("Kimi tool history requires nonempty reasoning; start a new session")
                            if (seen.has(part.toolCallId)) throw new Error("Kimi history contains duplicate tool call IDs")
                            seen.add(part.toolCallId)
                            pending.set(part.toolCallId, part.toolName)
                            return {
                                type: "tool-call", toolCallId: part.toolCallId,
                                toolName: part.toolName, input: structuredClone(part.input),
                            }
                        }
                    }
                })
                if (content.length > 0) projected.push({ role: "assistant", content })
                break
            }
            case "toolResult": {
                if (!pending.has(message.toolCallId) || pending.get(message.toolCallId) !== message.toolName) {
                    throw new Error("Kimi history contains an unpaired tool result; start a new session")
                }
                pending.delete(message.toolCallId)
                const content: ToolContent = [{
                    type: "tool-result", toolCallId: message.toolCallId, toolName: message.toolName,
                    output: { type: message.isError ? "error-text" : "text", value: message.content },
                }]
                projected.push({ role: "tool", content })
                break
            }
        }
    }
    if (pending.size > 0) throw new Error("Kimi history contains unresolved tool calls; start a new session")
    return projected
}
