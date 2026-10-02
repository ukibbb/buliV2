import { expect, test } from "bun:test"
import type { IAssistantMessage, IToolResultMessage } from "@/agent"
import { projectToolActivities } from "./transcript-projection"

const assistant: IAssistantMessage = {
    id: "assistant", sessionId: "session", runId: "run", createdAt: 1,
    role: "assistant", stopReason: "tool-calls",
    content: [{ type: "toolCall", toolCallId: "call", toolName: "read", input: {} }],
}
const result: IToolResultMessage = {
    id: "result", sessionId: assistant.sessionId, runId: assistant.runId, createdAt: 2,
    role: "toolResult", assistantMessageId: assistant.id,
    toolCallId: "call", toolName: "read", content: "Contents", isError: false,
}

test.each(["assistantMessageId", "sessionId", "runId", "toolCallId", "toolName"] as const)(
    "leaves a mismatched %s result orphaned without completing the active call",
    (field) => {
        const invalid = { ...result, [field]: "other" }
        const projection = projectToolActivities([assistant, invalid], assistant.runId)
        expect(projection.resultsByAssistantMessageId.size).toBe(0)
        expect(projection.matchedToolResultMessageIds.size).toBe(0)
        expect(projection.activeAssistantMessageId).toBe(assistant.id)
        expect([...projection.activeToolCallIds]).toEqual(["call"])

        const completed = projectToolActivities([assistant, invalid, { ...result, id: "valid" }], assistant.runId)
        expect([...completed.matchedToolResultMessageIds]).toEqual(["valid"])
        expect(completed.resultsByAssistantMessageId.get(assistant.id)?.get("call")?.id).toBe("valid")
        expect(completed.activeToolCallIds.size).toBe(0)
    },
)

test("does not reuse a result from a previous assistant in the same run", () => {
    const nextAssistant = { ...assistant, id: "next-assistant" }
    const lateDuplicate = { ...result, id: "late-result" }
    const projection = projectToolActivities([assistant, result, nextAssistant, lateDuplicate], assistant.runId)
    expect([...projection.matchedToolResultMessageIds]).toEqual([result.id])
    expect(projection.activeAssistantMessageId).toBe(nextAssistant.id)
    expect([...projection.activeToolCallIds]).toEqual(["call"])
})
