import { describe, expect, test } from "bun:test"
import type { IAgentModelRequest, IAssistantMessage, IUserMessage, TAgentMessage } from "@/agent"
import type { ICompactionCheckpoint } from "@/sessions/compaction/checkpoint"
import { projectCompactionCandidate } from "@/sessions/compaction/context-projector"
import { compactSessionMessages } from "@/sessions/compaction/session-compactor"
import type { IRequiredContext } from "@/sessions/history-contracts"
import { SQLiteSessionManager } from "@/sessions/sqlite/sqlite-session-manager"

const SESSION_ID = "suffix-session"
const PREVIOUS_COUNT = 100
const previous: ICompactionCheckpoint = {
    id: "previous", sessionId: SESSION_ID, createdAt: 1, reason: "manual",
    compactedMessageCount: PREVIOUS_COUNT, throughMessageId: "M100",
    summary: "Earlier actionable facts 🐂\n".repeat(100).trim(),
}

function user(index: number): IUserMessage {
    return { id: `M${index}`, sessionId: SESSION_ID, runId: "run", createdAt: index,
        role: "user", source: "prompt", content: `Question ${index}` }
}

function assistant(index: number): IAssistantMessage {
    return { id: `M${index}`, sessionId: SESSION_ID, runId: "run", createdAt: index,
        role: "assistant", stopReason: "stop", content: [{ type: "text", text: `Answer ${index}` }] }
}

function context(messages: readonly TAgentMessage[] = []): IRequiredContext {
    return { messages, checkpoint: previous, contextSummary: previous.summary }
}

function summarizer(summary = "Short cumulative checkpoint 🐂") {
    const requests: IAgentModelRequest[] = []
    return {
        requests,
        options: {
            sessionId: SESSION_ID,
            runConfiguration: {
                model: { async *stream(request: IAgentModelRequest) {
                    requests.push(request)
                    yield { type: "text-delta" as const, id: "summary", delta: summary }
                    yield { type: "finish" as const, reason: "stop" }
                } },
                reasoningEffort: "low" as const,
            },
            reason: "automatic" as const,
            signal: new AbortController().signal,
            now: () => 200,
            generateId: () => "candidate",
        },
    }
}

function prompt(request: IAgentModelRequest | undefined): string {
    const message = request?.messages[0]
    if (message?.role !== "user") throw new Error("Expected compaction prompt")
    return message.content
}

describe("suffix-only compaction", () => {
    test("adds 40 eligible messages to an absolute boundary of 100 without reading the old prefix", async () => {
        const eligible = Array.from({ length: 40 }, (_, index) => index % 2 === 0 ? user(index + 101) : assistant(index + 101))
        const trailing = [user(141), { ...user(142), source: "steer" as const }]
        const input = context([...eligible, ...trailing])
        const original = structuredClone(input)
        const { options, requests } = summarizer()
        const checkpoint = await compactSessionMessages({ ...options, context: input })
        expect(checkpoint).toMatchObject({ throughMessageId: "M140", compactedMessageCount: 140 })
        expect(requests).toHaveLength(1)
        expect(requests[0]?.contextSummary).toBe(previous.summary)
        const expectedHistory = Array.from({ length: 40 }, (_, index) => index % 2 === 0
            ? `[User]\nQuestion ${index + 101}` : `[Assistant]\nAnswer ${index + 101}`).join("\n\n")
        expect(prompt(requests[0])).toBe(`Conversation history to incorporate:\n\n${expectedHistory}\n\nMerge this history into the cumulative operational checkpoint.`)
        expect(input).toEqual(original)
        expect(projectCompactionCandidate(input, checkpoint!)).toEqual({
            messages: trailing, contextSummary: checkpoint!.summary, checkpoint: checkpoint!,
        })
    })

    for (const messages of [[], [user(101), user(102)]] as const) {
        test(`recompresses the same absent anchor and retains ${messages.length} unprocessed messages`, async () => {
            const input = context(messages)
            const { options, requests } = summarizer()
            const checkpoint = await compactSessionMessages({ ...options, context: input, allowSummaryRecompression: true })
            expect(checkpoint).toMatchObject({ throughMessageId: "M100", compactedMessageCount: 100 })
            expect(requests).toHaveLength(1)
            expect(requests[0]?.contextSummary).toBeUndefined()
            expect(prompt(requests[0])).toBe(`Operational checkpoint to recompress:\n\n${previous.summary}\n\nRewrite this content as a materially shorter cumulative operational checkpoint while preserving every actionable fact.`)
            expect(projectCompactionCandidate(input, checkpoint!).messages).toEqual(messages)
        })
    }

    test("does not call the model for an unprocessed suffix without recompression permission", async () => {
        const { options, requests } = summarizer()
        expect(await compactSessionMessages({ ...options, context: context([user(101)]) })).toBeUndefined()
        expect(requests).toEqual([])
    })

    test("rejects nonshrinking recompression without changing its captured input", async () => {
        const input = context([user(101)])
        const original = structuredClone(input)
        const { options, requests } = summarizer(previous.summary)
        expect(await compactSessionMessages({ ...options, context: input, allowSummaryRecompression: true })).toBeUndefined()
        expect(requests).toHaveLength(1)
        expect(input).toEqual(original)
    })

    const invalidInputs: readonly { readonly name: string; readonly input: IRequiredContext; readonly error: string }[] = [
        { name: "summary without boundary", input: { messages: [], contextSummary: "unanchored" }, error: "requires its checkpoint boundary" },
        { name: "summary different from boundary", input: { ...context(), contextSummary: "different" }, error: "summary disagrees" },
        { name: "missing summary", input: { messages: [], checkpoint: previous }, error: "summary disagrees" },
        { name: "wrong checkpoint session", input: { ...context(), checkpoint: { ...previous, sessionId: "other" } }, error: "belongs to another session" },
        { name: "wrong message session", input: context([{ ...assistant(101), sessionId: "other" }]), error: "different sessions" },
        { name: "anchor in suffix", input: context([assistant(100)]), error: "only messages after its checkpoint" },
        { name: "unsafe prior count", input: { ...context(), checkpoint: { ...previous, compactedMessageCount: Number.MAX_SAFE_INTEGER + 1 } }, error: "Invalid compaction checkpoint" },
        { name: "cumulative count overflow", input: { ...context([assistant(101)]), checkpoint: { ...previous, compactedMessageCount: Number.MAX_SAFE_INTEGER } }, error: "safe integer range" },
    ]
    for (const { name, input, error } of invalidInputs) {
        test(`rejects ${name} before any summarizer request`, async () => {
            const { options, requests } = summarizer()
            await expect(compactSessionMessages({ ...options, context: input, allowSummaryRecompression: true })).rejects.toThrow(error)
            expect(requests).toEqual([])
        })
    }

    test("candidate validates relative anchors, complete tool groups and the eligible cutoff", () => {
        const owner: IAssistantMessage = { ...assistant(101), stopReason: "toolUse", content: [
            { type: "toolCall", toolCallId: "call", toolName: "read", input: {} },
        ] }
        const result: TAgentMessage = { id: "M102", sessionId: SESSION_ID, runId: owner.runId, createdAt: 102,
            role: "toolResult", assistantMessageId: owner.id, toolCallId: "call", toolName: "read", content: "Full result", isError: false }
        const input = context([owner, result, user(103)])
        const candidate = { ...previous, id: "candidate", compactedMessageCount: 102, throughMessageId: "M102" }
        expect(projectCompactionCandidate(input, candidate).messages).toEqual([user(103)])
        expect(() => projectCompactionCandidate(input, { ...candidate, compactedMessageCount: 101, throughMessageId: owner.id })).toThrow("does not match session")
        expect(() => projectCompactionCandidate(input, { ...candidate, throughMessageId: "wrong" })).toThrow("does not match session")
        expect(() => projectCompactionCandidate(input, { ...candidate, compactedMessageCount: 103, throughMessageId: "M103" })).toThrow("captured context")
        expect(() => projectCompactionCandidate(input, { ...candidate, compactedMessageCount: 100 })).toThrow("unchanged boundary")
        expect(() => projectCompactionCandidate(input, { ...candidate, compactedMessageCount: 99 })).toThrow("captured context")
        expect(() => projectCompactionCandidate(input, { ...candidate, sessionId: "other" })).toThrow("captured context")
    })

    test("SQLite suffix compaction reloads all messages committed while the summary was in flight", async () => {
        const manager = new SQLiteSessionManager({ databasePath: ":memory:" })
        try {
            manager.createSession({ id: SESSION_ID, agentId: "buli", title: "Suffix", createdAt: 1, updatedAt: 1 })
            for (let index = 1; index <= 102; index++) manager.appendMessage(index % 2 === 0 ? assistant(index) : user(index))
            manager.saveCompactionCheckpoint(previous)
            const captured = manager.loadRequiredContext(SESSION_ID)
            expect(captured.messages.map((message) => message.id)).toEqual(["M101", "M102"])
            const { options } = summarizer()
            const checkpoint = await compactSessionMessages({ ...options, context: captured, onProgress: () => {
                manager.appendMessage(user(103))
                manager.appendMessage(user(104))
            } })
            expect(checkpoint).toMatchObject({ compactedMessageCount: 102, throughMessageId: "M102" })
            expect(projectCompactionCandidate(captured, checkpoint!).messages).toEqual([])
            manager.saveCompactionCheckpoint(checkpoint!)
            const reloaded = manager.loadRequiredContext(SESSION_ID)
            expect(reloaded.messages.map((message) => message.id)).toEqual(["M103", "M104"])
            expect(reloaded.contextSummary).toBe(checkpoint!.summary)
            expect(captured.messages.map((message) => message.id)).toEqual(["M101", "M102"])
        } finally {
            manager.dispose()
        }
    })
})
