import { expect, test } from "bun:test"
import { InMemorySessionManager } from "@/sessions/in-memory-session-manager"
import { SessionRecordType as Kind } from "@/sessions/jsonl/session-records"
import { replaySessionRecords } from "@/sessions/jsonl/session-replay"
import type { ISessionArchive } from "@/sessions/repository"

function archive(): ISessionArchive {
    return {
        info: { id: "s", agentId: "buli", title: "Test", createdAt: 1, updatedAt: 3 },
        activeBranchId: "side",
        branches: [
            {
                branch: { id: "main", origin: null, inheritedCheckpointId: null },
                messages: [{ id: "A", sessionId: "s", runId: "r", role: "user", source: "prompt", content: "Parent", createdAt: 2 }],
                checkpoints: [{ id: "cp", sessionId: "s", createdAt: 3, reason: "manual", summary: "Parent summary", throughMessageId: "A", compactedMessageCount: 1 }],
            },
            {
                branch: { id: "side", origin: { branchId: "main", throughMessageId: "A" }, inheritedCheckpointId: "cp" },
                messages: [{ id: "X", sessionId: "s", runId: "r2", role: "user", source: "prompt", content: "Side", createdAt: 3 }],
                checkpoints: [{ id: "side-cp", sessionId: "s", createdAt: 3, reason: "manual", summary: "Side summary", throughMessageId: "X", compactedMessageCount: 2 }],
            },
        ],
        fileChangeProposals: [{ id: "p", sessionId: "s", runId: "r", toolCallId: "t", operation: "edit", path: "example.ts", diff: "-old\n+new\n", status: "pending", createdAt: 2 }],
    }
}

test("restores full archive and returns without side messages or summaries", () => {
    const manager = new InMemorySessionManager()
    const input = archive()
    manager.restoreSessionArchive(input)
    expect(manager.getSessionArchive("s")).toEqual(input)
    expect(manager.getActiveContext("s").branchId).toBe("side")
    expect(manager.getMessages("s").map((item) => item.id)).toEqual(["A", "X"])
    expect(manager.getCompactionCheckpoint("s")?.id).toBe("side-cp")
    manager.returnToParentBranch("s")
    expect(manager.getMessages("s").map((item) => item.id)).toEqual(["A"])
    expect(manager.getCompactionCheckpoint("s")?.id).toBe("cp")
    expect(manager.getSessionArchive("s").branches).toHaveLength(2)
})

test("restores replay output without replaying navigation through the manager", () => {
    const input = archive()
    const result = replaySessionRecords([
        { recordType: Kind.Session, session: input.info },
        { recordType: Kind.Message, branchId: "main", message: input.branches[0]!.messages[0]! },
        { recordType: Kind.Compaction, branchId: "main", checkpoint: input.branches[0]!.checkpoints[0]! },
        { recordType: Kind.Branch, sessionId: "s", branch: input.branches[1]!.branch },
        { recordType: Kind.Message, branchId: "side", message: input.branches[1]!.messages[0]! },
    ])
    const manager = new InMemorySessionManager()
    manager.restoreSessionArchive(result.archives[0]!)
    expect(manager.getSessionArchive("s")).toEqual(result.archives[0]!)
    expect(manager.getActiveContext("s").checkpoint?.id).toBe("cp")
})

test("retains unsuitable checkpoints and falls back to inherited checkpoint", () => {
    const input = archive()
    const side = input.branches[1]!
    const changed: ISessionArchive = { ...input, branches: [input.branches[0]!, {
        ...side, checkpoints: [{ ...side.checkpoints[0]!, throughMessageId: "missing" }],
    }] }
    const manager = new InMemorySessionManager()
    manager.restoreSessionArchive(changed)
    expect(manager.getCompactionCheckpoint("s")?.id).toBe("cp")
    expect(manager.getSessionArchive("s")).toEqual(changed)
})

test("rejects invalid archives without publishing partial state or consuming a revision", () => {
    const input = archive()
    const main = input.branches[0]!
    const side = input.branches[1]!
    const invalid: ISessionArchive[] = [
        { ...input, info: { ...input.info, title: "" } },
        { ...input, activeBranchId: "missing" },
        { ...input, branches: [] },
        { ...input, branches: [main, main] },
        { ...input, branches: [main, { ...side, branch: { ...side.branch, origin: { branchId: "missing", throughMessageId: "A" } } }] },
        { ...input, branches: [main, { ...side, branch: { ...side.branch, origin: { branchId: "side", throughMessageId: "A" } } }] },
        { ...input, branches: [main, { ...side, branch: { ...side.branch, inheritedCheckpointId: "missing" } }] },
        { ...input, branches: [main, { ...side, messages: main.messages }] },
        { ...input, branches: [main, { ...side, checkpoints: main.checkpoints }] },
        { ...input, branches: [main, { ...side, messages: [{ ...side.messages[0]!, sessionId: "other" }] }] },
        { ...input, branches: [main, { ...side, checkpoints: [{ ...side.checkpoints[0]!, sessionId: "other" }] }] },
        { ...input, fileChangeProposals: [input.fileChangeProposals[0]!, input.fileChangeProposals[0]!] },
        { ...input, fileChangeProposals: [{ ...input.fileChangeProposals[0]!, sessionId: "other" }] },
        { ...input, fileChangeProposals: [{ ...input.fileChangeProposals[0]!, id: "" }] },
    ]
    for (const candidate of invalid) {
        const manager = new InMemorySessionManager()
        manager.createSession({ ...input.info, id: "retained" })
        const retained = manager.getSessionArchive("retained")
        const revision = manager.getPresentationRevision("retained")
        expect(() => manager.restoreSessionArchive(candidate)).toThrow()
        expect(manager.getSessionInfo("s")).toBeUndefined()
        expect(manager.getPresentationRevision("s")).toBe(-1)
        expect(manager.getMessages("s")).toEqual([])
        expect(manager.getFileChangeProposals("s")).toEqual([])
        expect(manager.getSessionArchive("retained")).toEqual(retained)
        expect(manager.getPresentationRevision("retained")).toBe(revision)
        manager.restoreSessionArchive(input)
        expect(manager.getPresentationRevision("s")).toBe(revision + 1)
    }
})

test("does not overwrite an existing session", () => {
    const manager = new InMemorySessionManager()
    manager.restoreSessionArchive(archive())
    const before = manager.getSessionArchive("s")
    const revision = manager.getPresentationRevision("s")
    expect(() => manager.restoreSessionArchive({ ...archive(), activeBranchId: "main" })).toThrow("already exists")
    expect(manager.getSessionArchive("s")).toEqual(before)
    expect(manager.getPresentationRevision("s")).toBe(revision)
})

test("owns defensive copies of every restored archive payload", () => {
    const manager = new InMemorySessionManager()
    const input = archive()
    const before = structuredClone(input)
    manager.restoreSessionArchive(input)
    ;(input.info as { title: string }).title = "changed"
    ;(input.branches[0]!.messages[0] as { content: string }).content = "changed"
    ;(input.branches[0]!.checkpoints[0] as { summary: string }).summary = "changed"
    ;(input.branches[1]!.branch.origin as { branchId: string }).branchId = "changed"
    ;(input.fileChangeProposals[0] as { path: string }).path = "changed"
    expect(manager.getSessionArchive("s")).toEqual(before)
})

test("allocates a fresh revision on delete and restore", () => {
    const manager = new InMemorySessionManager()
    manager.restoreSessionArchive(archive())
    const revision = manager.getPresentationRevision("s")
    manager.deleteSession("s")
    manager.restoreSessionArchive(archive())
    expect(manager.getPresentationRevision("s")).toBeGreaterThan(revision)
})

test("restored shared messages and checkpoints remain protected", () => {
    const manager = new InMemorySessionManager()
    const input = archive()
    manager.restoreSessionArchive(input)
    manager.returnToParentBranch("s")
    expect(() => manager.appendMessage({ ...input.branches[0]!.messages[0]!, createdAt: 9 })).toThrow("inherited")
    expect(() => manager.saveCompactionCheckpoint({ ...input.branches[0]!.checkpoints[0]!, summary: "changed" })).toThrow("inherited")
})
