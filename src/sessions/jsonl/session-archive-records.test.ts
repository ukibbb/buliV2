import { expect, test } from "bun:test"
import { InMemorySessionManager } from "@/sessions/in-memory-session-manager"
import { sessionArchiveRecords } from "@/sessions/jsonl/session-archive-records"
import { replaySessionRecords } from "@/sessions/jsonl/session-replay"

function fixture() {
    const manager = new InMemorySessionManager()
    manager.createSession({ id: "s", agentId: "buli", title: "Test", createdAt: 1, updatedAt: 1 })
    manager.appendMessage({ id: "A", sessionId: "s", runId: "r", role: "user", source: "prompt", content: "A", createdAt: 2 })
    manager.saveCompactionCheckpoint({ id: "cp", sessionId: "s", createdAt: 3, reason: "manual", summary: "Parent", throughMessageId: "A", compactedMessageCount: 1 })
    manager.createBranch("s", "side")
    manager.createBranch("s", "nested")
    manager.returnToParentBranch("s")
    manager.returnToParentBranch("s")
    manager.createBranch("s", "sibling")
    return manager.getSessionArchive("s")
}

test("serializes parents first even when archive branches are out of order", () => {
    const archive = fixture()
    const reordered = { ...archive, branches: [...archive.branches].reverse() }
    const records = sessionArchiveRecords(reordered)
    const result = replaySessionRecords(records).archives[0]!
    expect(result.activeBranchId).toBe("sibling")
    expect(result.branches).toHaveLength(4)
    expect(new Map(result.branches.map((data) => [data.branch.id, data])))
        .toEqual(new Map(archive.branches.map((data) => [data.branch.id, data])))
    expect(records.at(-1)).toEqual({ recordType: "branchSelection", sessionId: "s", branchId: "sibling" })
})

test("archive serialization rejects duplicate branches and invalid selection", () => {
    const archive = fixture()
    expect(() => sessionArchiveRecords({ ...archive, branches: [...archive.branches, archive.branches[0]!] })).toThrow()
    expect(() => sessionArchiveRecords({ ...archive, activeBranchId: "missing" })).toThrow()
})

test("serialized record payloads do not alias archive payloads", () => {
    const archive = fixture()
    const before = structuredClone(archive)
    const records = sessionArchiveRecords(archive)
    const session = records[0]!
    if (session.recordType !== "session") throw new Error("Expected session")
    ;(session.session as { title: string }).title = "changed"
    expect(archive).toEqual(before)
})
