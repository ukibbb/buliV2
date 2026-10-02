import { expect, test } from "bun:test"
import type { TAgentMessage } from "@/agent"
import {
    assertCheckpointAnchor,
    assertCheckpointReferences,
    type ICompactionCheckpoint,
} from "@/sessions/compaction/checkpoint"
import { assertDurableSessionMessage } from "@/sessions/validation"

function user(id: string): TAgentMessage {
    return { id, sessionId: "s", runId: "r", role: "user", source: "prompt", content: id, createdAt: 1 }
}

function checkpoint(anchor = "A", count = 1): ICompactionCheckpoint {
    return { id: "cp", sessionId: "s", createdAt: 2, reason: "manual", summary: "Full summary",
        compactedMessageCount: count, throughMessageId: anchor }
}

test("anchor validation checks the prefix only and leaves the suffix untouched", () => {
    const messages = [user("A"), { id: "pending", sessionId: "s", runId: "r", createdAt: 1,
        role: "assistant" as const, stopReason: "toolCalls", content: [
            { type: "toolCall" as const, toolCallId: "t", toolName: "read", input: {} },
        ] }]
    expect(() => assertCheckpointAnchor(checkpoint(), messages)).not.toThrow()
    expect(() => assertCheckpointAnchor(checkpoint("pending", 2), messages))
        .toThrow("Compaction checkpoint does not match session s")
})

test.each([0, 2, 100])("rejects an out-of-range anchor count %i", (count) => {
    expect(() => assertCheckpointAnchor(checkpoint("A", count), [user("A")]))
        .toThrow("Compaction checkpoint does not match session s")
})

test("rejects a mismatched anchor without requesting tool-call identities", () => {
    let called = false
    expect(() => assertCheckpointReferences(checkpoint("missing"), [user("A")], () => {
        called = true
        return []
    })).toThrow("Compaction checkpoint does not match session s")
    expect(called).toBe(false)
})

test("keeps historical set semantics separate from durable message validation", () => {
    const call = { type: "toolCall" as const, toolCallId: "t", toolName: "read", input: {} }
    const assistant: TAgentMessage = { id: "A", sessionId: "s", runId: "r", createdAt: 1,
        role: "assistant", stopReason: "toolCalls", content: [call, call] }
    const result: TAgentMessage = { id: "R", sessionId: "s", runId: "r", createdAt: 1,
        role: "toolResult", assistantMessageId: assistant.id, toolCallId: "t", toolName: "read", content: "Done", isError: false }
    // A malformed durable message is rejected earlier; the anchor helper itself still uses a Set.
    expect(() => assertDurableSessionMessage(assistant)).toThrow("Invalid assistant tool call")
    expect(() => assertCheckpointAnchor(checkpoint("R", 2), [assistant, result])).not.toThrow()
})

test("shared metadata checks read only call IDs from completed assistants in the prefix", () => {
    const messages = [
        { id: "U", role: "user" as const },
        { id: "aborted", role: "assistant" as const, stopReason: "aborted" },
        { id: "A", role: "assistant" as const, stopReason: "toolCalls" },
        { id: "R", role: "toolResult" as const, assistantMessageId: "A", toolCallId: "t" },
        { id: "suffix", role: "assistant" as const, stopReason: "toolCalls" },
    ]
    const visited: string[] = []
    assertCheckpointReferences(checkpoint("R", 4), messages, (message) => {
        visited.push(message.id)
        return ["t"]
    })
    expect(visited).toEqual(["A"])
})

test("rejects a result with the correct call ID but a different assistant owner", () => {
    const messages = [
        { id: "A", role: "assistant" as const, stopReason: "toolCalls" },
        { id: "R", role: "toolResult" as const, assistantMessageId: "other", toolCallId: "t" },
    ]
    expect(() => assertCheckpointReferences(checkpoint("R", 2), messages, () => ["t"]))
        .toThrow("Compaction checkpoint does not match session s")
})

test("anchor helper does not add a session-ownership check owned by its callers", () => {
    const messages = [{ ...user("A"), sessionId: "other" }]
    expect(() => assertCheckpointAnchor(checkpoint(), messages)).not.toThrow()
})
