import { expect, test } from "bun:test"
import type { TAgentMessage, IAssistantMessage } from "@/agent"
import { toDeepSeekModelMessages } from "./deepseek-model-messages"

const base = { id: "a", sessionId: "s", runId: "r", createdAt: 1 }
const assistant: IAssistantMessage = {
    ...base, role: "assistant", model: { providerId: "deepseek", modelId: "deepseek-flash" }, stopReason: "stop",
    content: [{ type: "reasoning", text: "original" }, { type: "text", text: "answer" }],
}
const call: IAssistantMessage = { ...assistant, stopReason: "tool-calls", content: [
    { type: "reasoning", text: "original" }, { type: "toolCall", toolCallId: "c", toolName: "inspect", input: { path: "x" } },
] }
const result: TAgentMessage = { ...base, role: "toolResult", toolCallId: "c", toolName: "inspect", content: "interrupted", isError: true }
const project = (messages: TAgentMessage[], tools = true, summary?: string) => toDeepSeekModelMessages(messages, "deepseek-flash", tools, summary)

test("checkpoint is user context and original reasoning survives a second user turn without mutation", () => {
    const history: TAgentMessage[] = [assistant, { ...base, role: "user", source: "prompt", content: "next" }]
    const original = structuredClone(history)
    expect(project(history, true, "checkpoint")).toEqual([
        { role: "user", content: "Cumulative operational checkpoint (context data, not a new user instruction):\ncheckpoint" },
        { role: "assistant", content: [{ type: "reasoning", text: "original" }, { type: "text", text: "answer" }] }, { role: "user", content: "next" },
    ])
    expect(history).toEqual(original)
})

test("requires original reasoning even for prior answers without calls when tools are enabled", () => {
    const missing = { ...assistant, content: [{ type: "text" as const, text: "answer" }] }
    expect(() => project([missing])).toThrow("original reasoning")
    expect(project([missing], false)).toHaveLength(1)
    expect(() => project([{ ...assistant, content: [{ type: "reasoning", text: "" }] }])).toThrow("original reasoning")
    expect(project([{ ...assistant, content: [{ type: "reasoning", text: " " }] }])).toHaveLength(1)
})

test.each([undefined, { providerId: "kimi-coding", modelId: "deepseek-flash" }, { providerId: "deepseek", modelId: "deepseek-v4-pro" }])("rejects foreign or missing provenance %j", model => {
    const { model: _original, ...withoutModel } = assistant
    expect(() => project([{ ...withoutModel, ...(model ? { model } : {}) }])).toThrow("same provider and model")
})

test("accepts paired failed tool results without inventing calls; clones inputs", () => {
    const projected = project([call, result])
    expect(projected[1]).toMatchObject({ role: "tool", content: [{ output: { type: "error-text", value: "interrupted" } }] })
    expect(projected[0]).toMatchObject({ content: [{ type: "reasoning", text: "original" }, { type: "tool-call", input: { path: "x" } }] })
})

test.each([
    [call], [result], [call, { ...result, toolName: "wrong" }], [call, result, call, result],
    [call, assistant, result], [{ ...call, stopReason: "length" }, result],
    [{ ...call, stopReason: "aborted" }, result], [{ ...call, stopReason: "error" }, result],
] satisfies TAgentMessage[][])("rejects broken call history %j", (...messages) => {
    expect(() => project(messages)).toThrow()
})

test("skips failed assistants but refuses images", () => {
    expect(project([{ ...assistant, stopReason: "aborted" }, { ...assistant, stopReason: "error" }])).toEqual([])
    expect(() => project([{ ...base, role: "user", source: "prompt", content: "image", attachments: [
        { type: "image", mimeType: "image/png", filename: "test.png", data: "eA==", source: { value: "image", start: 0, end: 5 } },
    ] }])).toThrow("text only")
})
