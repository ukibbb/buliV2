import { expect, test } from "bun:test"
import type { IUserMessage } from "@/agent"
import { MAIN_BRANCH_ID, resolveBranchContext } from "@/sessions/branches"
import type { ICompactionCheckpoint } from "@/sessions/compaction/checkpoint"
import { InMemorySessionManager } from "@/sessions/in-memory-session-manager"

function setup() {
    const manager = new InMemorySessionManager()
    manager.createSession({ id: "s", agentId: "buli", title: "Test", createdAt: 1, updatedAt: 1 })
    return manager
}

function message(id: string): IUserMessage {
    return { id, sessionId: "s", runId: id, role: "user", source: "prompt", content: id, createdAt: 2 }
}

function checkpoint(id: string, anchor: string, count: number): ICompactionCheckpoint {
    return { id, sessionId: "s", createdAt: 3, reason: "manual", summary: id,
        throughMessageId: anchor, compactedMessageCount: count }
}

function ids(manager: InMemorySessionManager) {
    return manager.getMessages("s").map((item) => item.id)
}

function assertUnchanged(manager: InMemorySessionManager, operation: () => void) {
    const archive = manager.getSessionArchive("s")
    const revision = manager.getPresentationRevision("s")
    expect(operation).toThrow()
    expect(manager.getSessionArchive("s")).toEqual(archive)
    expect(manager.getPresentationRevision("s")).toBe(revision)
}

test("creates main and returns through nested branches without deleting history", () => {
    const manager = setup()
    expect(manager.getActiveContext("s").branchId).toBe(MAIN_BRANCH_ID)
    manager.appendMessage(message("A"))
    manager.createBranch("s", "side")
    manager.appendMessage(message("X"))
    manager.createBranch("s", "nested")
    manager.appendMessage(message("P"))
    expect(ids(manager)).toEqual(["A", "X", "P"])
    manager.returnToParentBranch("s")
    expect(ids(manager)).toEqual(["A", "X"])
    manager.returnToParentBranch("s")
    manager.appendMessage(message("B"))
    expect(ids(manager)).toEqual(["A", "B"])
    const archive = manager.getSessionArchive("s")
    expect(archive.activeBranchId).toBe(MAIN_BRANCH_ID)
    expect(archive.branches.map((data) => data.messages.map((item) => item.id)))
        .toEqual([["A", "B"], ["X"], ["P"]])
    expect(manager.getAllMessages().map((item) => item.id)).toEqual(["A", "B", "X", "P"])
    const branches = new Map(archive.branches.map((data) => [data.branch.id, data]))
    expect(resolveBranchContext(branches, "nested").messages.map((item) => item.id))
        .toEqual(["A", "X", "P"])
})

test("empty branches support nesting and return", () => {
    const manager = setup()
    manager.createBranch("s", "empty")
    manager.createBranch("s", "nested")
    expect(ids(manager)).toEqual([])
    manager.returnToParentBranch("s")
    manager.returnToParentBranch("s")
    expect(manager.getActiveContext("s").branchId).toBe(MAIN_BRANCH_ID)
})

test("preserves inherited checkpoints and isolates child compaction", () => {
    const manager = setup()
    manager.appendMessage(message("A"))
    const parent = checkpoint("parent", "A", 1)
    manager.saveCompactionCheckpoint(parent)
    manager.createBranch("s", "side")
    expect(manager.getCompactionCheckpoint("s")).toEqual(parent)
    manager.appendMessage(message("X"))
    const child = checkpoint("child", "X", 2)
    manager.saveCompactionCheckpoint(child)
    expect(manager.getCompactionCheckpoint("s")).toEqual(child)
    assertUnchanged(manager, () => manager.saveCompactionCheckpoint(parent))
    manager.returnToParentBranch("s")
    expect(manager.getCompactionCheckpoint("s")).toEqual(parent)
    assertUnchanged(manager, () => manager.saveCompactionCheckpoint({ ...parent, summary: "changed" }))
    manager.saveCompactionCheckpoint(parent)
    manager.saveCompactionCheckpoint(checkpoint("new-parent", "A", 1))
    const archive = manager.getSessionArchive("s")
    expect(archive.branches[0]!.checkpoints).toHaveLength(2)
    const branches = new Map(archive.branches.map((data) => [data.branch.id, data]))
    expect(resolveBranchContext(branches, "side").checkpoint).toEqual(child)
})

test("protects inherited messages but permits own identical writes and unshared replacements", () => {
    const manager = setup()
    manager.appendMessage(message("A"))
    manager.createBranch("s", "side")
    assertUnchanged(manager, () => manager.appendMessage(message("A")))
    manager.appendMessage(message("X"))
    manager.returnToParentBranch("s")
    assertUnchanged(manager, () => manager.appendMessage({ ...message("A"), content: "changed" }))
    manager.appendMessage(message("A"))
    expect(ids(manager)).toEqual(["A"])
    assertUnchanged(manager, () => manager.appendMessage(message("X")))
    manager.appendMessage(message("B"))
    manager.appendMessage({ ...message("B"), content: "updated" })
    expect(manager.getMessages("s")[1]).toMatchObject({ content: "updated" })
})

test("rejects invalid operations atomically and advances revisions only on successful navigation", () => {
    const manager = setup()
    assertUnchanged(manager, () => manager.returnToParentBranch("s"))
    assertUnchanged(manager, () => manager.createBranch("s", " "))
    assertUnchanged(manager, () => manager.createBranch("s", MAIN_BRANCH_ID))
    assertUnchanged(manager, () => manager.createBranch("missing", "side"))
    assertUnchanged(manager, () => manager.saveCompactionCheckpoint(checkpoint("bad", "missing", 1)))
    const before = manager.getPresentationRevision("s")
    manager.createBranch("s", "side")
    expect(manager.getPresentationRevision("s")).toBeGreaterThan(before)
    assertUnchanged(manager, () => manager.createBranch("s", "side"))
    const branched = manager.getPresentationRevision("s")
    manager.returnToParentBranch("s")
    expect(manager.getPresentationRevision("s")).toBeGreaterThan(branched)
})

test("archive and active context are defensive copies", () => {
    const manager = setup()
    manager.appendMessage(message("A"))
    manager.saveCompactionCheckpoint(checkpoint("cp", "A", 1))
    const before = manager.getSessionArchive("s")
    const archive = manager.getSessionArchive("s")
    ;(archive.info as { title: string }).title = "changed"
    ;(archive.branches[0]!.messages[0] as { content: string }).content = "changed"
    ;(archive.branches[0]!.checkpoints[0] as { summary: string }).summary = "changed"
    ;(archive.branches[0]!.branch as { id: string }).id = "changed"
    const context = manager.getActiveContext("s")
    ;(context.messages[0] as { content: string }).content = "changed"
    ;(context.checkpoint as { summary: string }).summary = "changed"
    expect(manager.getSessionArchive("s")).toEqual(before)
})

test("deletion removes all branches without affecting other sessions", () => {
    const manager = setup()
    manager.appendMessage(message("A"))
    manager.createBranch("s", "side")
    manager.appendMessage(message("X"))
    manager.createSession({ id: "other", agentId: "buli", title: "Other", createdAt: 1, updatedAt: 1 })
    manager.deleteSession("s")
    expect(manager.getMessages("s")).toEqual([])
    expect(manager.getCompactionCheckpoint("s")).toBeUndefined()
    expect(manager.getAllMessages()).toEqual([])
    expect(() => manager.getActiveContext("s")).toThrow("does not exist")
    expect(() => manager.getSessionArchive("s")).toThrow("does not exist")
    expect(manager.getSessionArchive("other").branches).toHaveLength(1)
    manager.createSession({ id: "s", agentId: "buli", title: "New", createdAt: 1, updatedAt: 1 })
    expect(manager.getSessionArchive("s").branches).toHaveLength(1)
})
