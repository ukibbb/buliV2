import { expect, test } from "bun:test"
import type { IAssistantMessage } from "@/agent"
import { currentAssistantError } from "./current-error"

const error = { id: "failed", runId: "old", errorMessage: "Provider failed" }
const failed: IAssistantMessage = {
    ...error, sessionId: "session", role: "assistant",
    createdAt: 1, stopReason: "error", content: [],
}
const state = { assistantError: error, isRunning: false, isCompacting: false }

test("selects accepted error metadata without retaining history", () => {
    expect(currentAssistantError(state)).toEqual(error)
})

test("does not bring older errors into a new run or compaction", () => {
    expect(currentAssistantError({ ...state, isRunning: true, activeRunId: "new" })).toBeUndefined()
    expect(currentAssistantError({ ...state, isCompacting: true })).toBeUndefined()
    expect(currentAssistantError({ isRunning: false, isCompacting: false })).toBeUndefined()
    const { errorMessage: _error, ...successful } = failed
    expect(currentAssistantError({ ...state, streamingMessage: { ...successful, id: "new" } })).toBeUndefined()
})

test("selects a live error only from the active run", () => {
    expect(currentAssistantError({ ...state, isRunning: true, activeRunId: "old", streamingMessage: failed })).toEqual(error)
    expect(currentAssistantError({ ...state, isRunning: true, activeRunId: "new", streamingMessage: failed })).toBeUndefined()
})
