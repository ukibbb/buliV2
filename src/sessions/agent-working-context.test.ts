import { describe, expect, test } from "bun:test"
import type { IAssistantMessage, IUserMessage } from "@/agent"
import { AgentWorkingContext } from "@/sessions/agent-working-context"

const user = (id: string): IUserMessage => ({ id, sessionId: "s", runId: "r", role: "user", content: id, source: "prompt", createdAt: 1 })

describe("AgentWorkingContext", () => {
    test("exposes one stable deep-frozen view, isolated from its inputs", () => {
        const input = { nested: { values: [1, 2] } }
        const assistant: IAssistantMessage = { id: "a", sessionId: "s", runId: "r", role: "assistant", createdAt: 2, stopReason: "toolUse",
            content: [{ type: "toolCall", toolCallId: "call", toolName: "test", input }] }
        const messages = [assistant]
        const owner = new AgentWorkingContext({ messages, contextSummary: "full summary" })
        const view = owner.getContext()
        expect(owner.getContext()).toBe(view)
        expect(Object.isFrozen(view)).toBe(true)
        expect(Object.isFrozen(view.messages)).toBe(true)
        expect(Object.isFrozen(view.messages[0])).toBe(true)
        const accepted = view.messages[0] as IAssistantMessage
        const call = accepted.content[0]
        if (call?.type !== "toolCall") throw new Error("missing test call")
        expect(Object.isFrozen(accepted.content)).toBe(true)
        expect(Object.isFrozen(call.input.nested)).toBe(true)
        input.nested.values.push(3)
        messages.length = 0
        expect(call.input).toEqual({ nested: { values: [1, 2] } })
        expect(view.messages).toHaveLength(1)
        expect(() => { (call.input.nested as { values: number[] }).values.push(9) }).toThrow()
    })

    test("copies only the appended message and the reference array, preserving old request views", () => {
        const owner = new AgentWorkingContext({ messages: [user("first")], contextSummary: "summary" })
        const old = owner.getContext()
        const next = { ...user("second") }
        owner.acceptCommittedMessage(next)
        next.content = "caller mutation"
        const current = owner.getContext()
        expect(current).not.toBe(old)
        expect(current.messages[0]).toBe(old.messages[0])
        expect(current.messages[1]).toMatchObject({ content: "second" })
        expect(current.contextSummary).toBe("summary")
        expect(old.messages).toHaveLength(1)
        expect(current.messages).toHaveLength(2)
    })

    test("atomically replaces the suffix and removes an absent summary", () => {
        const owner = new AgentWorkingContext({ messages: [user("old")], contextSummary: "old summary" })
        const old = owner.getContext()
        owner.replaceContext({ messages: [user("M101"), user("M102")] })
        expect(owner.getContext()).toEqual({ messages: [user("M101"), user("M102")] })
        expect("contextSummary" in owner.getContext()).toBe(false)
        expect(old.contextSummary).toBe("old summary")
    })

    test("leaves the active view untouched if copying a replacement or append fails", () => {
        const owner = new AgentWorkingContext({ messages: [user("old")] })
        const old = owner.getContext()
        const invalid: IAssistantMessage = { id: "a", sessionId: "s", runId: "r", role: "assistant", createdAt: 2, stopReason: "toolUse",
            content: [{ type: "toolCall", toolCallId: "call", toolName: "test", input: { unsupported: () => 1 } }] }
        expect(() => owner.replaceContext({ messages: [user("valid"), invalid] })).toThrow()
        expect(owner.getContext()).toBe(old)
        expect(() => owner.acceptCommittedMessage(invalid)).toThrow()
        expect(owner.getContext()).toBe(old)
    })

    test("keeps the verified checkpoint and suffix in one immutable view through append and replacement", () => {
        const checkpoint = { id: "checkpoint", sessionId: "s", createdAt: 1, reason: "manual" as const,
            throughMessageId: "M100", compactedMessageCount: 100, summary: "Earlier facts",
            model: { providerId: "test", modelId: "model" } }
        const owner = new AgentWorkingContext({ messages: [user("M101")], contextSummary: checkpoint.summary, checkpoint })
        const old = owner.getContext()
        checkpoint.model.modelId = "mutated"
        expect(old.checkpoint).not.toBe(checkpoint)
        expect(old.checkpoint?.model?.modelId).toBe("model")
        expect(Object.isFrozen(old.checkpoint)).toBe(true)
        expect(Object.isFrozen(old.checkpoint?.model)).toBe(true)

        owner.acceptCommittedMessage(user("M102"))
        expect(owner.getContext().checkpoint).toBe(old.checkpoint)
        expect(owner.getContext().messages.map((message) => message.id)).toEqual(["M101", "M102"])
        expect(old.messages.map((message) => message.id)).toEqual(["M101"])

        const beforeFailure = owner.getContext()
        expect(() => owner.replaceContext({ messages: [], contextSummary: "New facts", checkpoint: {
            ...checkpoint, nonCloneable: () => undefined,
        } as typeof checkpoint })).toThrow()
        expect(owner.getContext()).toBe(beforeFailure)

        owner.replaceContext({ messages: [user("M101"), user("M102")] })
        expect(owner.getContext().checkpoint).toBeUndefined()
        expect(owner.getContext().contextSummary).toBeUndefined()
        expect(old.checkpoint?.throughMessageId).toBe("M100")
    })

    test("does not impose a UI message or byte limit", () => {
        const messages = Array.from({ length: 1_500 }, (_, index) => user(`m${index}`))
        const summary = "pełne podsumowanie 🐂".repeat(10_000)
        const owner = new AgentWorkingContext({ messages, contextSummary: summary })
        expect(owner.getContext().messages).toHaveLength(1_500)
        expect(owner.getContext().contextSummary).toBe(summary)
    })
})
