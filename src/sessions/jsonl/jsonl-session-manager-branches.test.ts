import { expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemorySessionManager } from "@/sessions/in-memory-session-manager"
import { JsonlSessionManager } from "@/sessions/jsonl/jsonl-session-manager"
import { sessionArchiveRecords } from "@/sessions/jsonl/session-archive-records"
import { serializeSessionRecords, type TSessionRecord } from "@/sessions/jsonl/session-records"
import { replaySessionRecords } from "@/sessions/jsonl/session-replay"

test("persists branch creation and return across restarts with isolated summaries", () => {
    withLog((_path, open) => {
        const manager = open()
        manager.createSession(fixture().info)
        manager.appendMessage(message("A"))
        const parent = fixture().branches[0]!.checkpoints[0]!
        manager.saveCompactionCheckpoint(parent)
        const revision = manager.getPresentationRevision("s")
        manager.createBranch("s", "side")
        expect(manager.getPresentationRevision("s")).toBeGreaterThan(revision)
        manager.appendMessage(message("X"))
        manager.saveCompactionCheckpoint({ ...parent, id: "child", summary: "Side", throughMessageId: "X", compactedMessageCount: 2 })
        manager.dispose()
        const restored = open()
        expect(restored.getActiveBranchId("s")).toBe("side")
        expect(restored.getCompactionCheckpoint("s")?.id).toBe("child")
        restored.returnToParentBranch("s")
        restored.dispose()
        const returned = open()
        expect(returned.getActiveBranchId("s")).toBe("main")
        expect(returned.getMessages("s")).toEqual([message("A")])
        expect(returned.getCompactionCheckpoint("s")).toEqual(parent)
        expect(exported(returned).branches).toHaveLength(2)
    })
})

test("branch navigation failures leave disk, memory and revision unchanged", () => {
    withLog((path, open) => {
        const manager = open()
        manager.createSession(fixture().info)
        manager.createBranch("s", "empty")
        const before = manager.exportSession("s")
        const contents = readFileSync(path, "utf8")
        const revision = manager.getPresentationRevision("s")
        expect(() => manager.createBranch("s", "empty")).toThrow()
        expect(() => manager.createBranch("s", " ")).toThrow()
        const append = spyOn(fs, "appendFileSync").mockImplementation(() => { throw new Error("disk failure") })
        try {
            expect(() => manager.createBranch("s", "nested")).toThrow("disk failure")
            expect(() => manager.returnToParentBranch("s")).toThrow("disk failure")
        } finally { append.mockRestore() }
        expect(manager.exportSession("s")).toBe(before)
        expect(readFileSync(path, "utf8")).toBe(contents)
        expect(manager.getPresentationRevision("s")).toBe(revision)
        manager.returnToParentBranch("s")
        const returned = readFileSync(path, "utf8")
        expect(() => manager.returnToParentBranch("s")).toThrow()
        expect(readFileSync(path, "utf8")).toBe(returned)
    })
})

test("first branch write failure does not activate or persist the staged session", () => {
    withLog((path, open) => {
        const manager = open()
        manager.createSession(fixture().info)
        const revision = manager.getPresentationRevision("s")
        const rename = spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("rename failure") })
        try {
            expect(() => manager.createBranch("s", "side")).toThrow("rename failure")
        } finally { rename.mockRestore() }
        expect(fs.existsSync(path)).toBe(false)
        expect(manager.getActiveBranchId("s")).toBe("main")
        expect(manager.getPresentationRevision("s")).toBe(revision)
        manager.createBranch("s", "side")
        manager.dispose()
        expect(open().getActiveBranchId("s")).toBe("side")
    })
})

test("read-only and disposed managers reject branch mutations", () => {
    withLog((path, open) => {
        const writer = open()
        writer.createSession(fixture().info)
        writer.createBranch("s", "side")
        const reader = new JsonlSessionManager({ filePath: path, readOnly: true })
        try {
            expect(reader.getActiveBranchId("s")).toBe("side")
            expect(() => reader.createBranch("s", "nested")).toThrow("read-only")
            expect(() => reader.returnToParentBranch("s")).toThrow("read-only")
        } finally { reader.dispose() }
        expect(() => reader.getActiveBranchId("s")).toThrow("disposed")
        expect(() => reader.createBranch("s", "nested")).toThrow("disposed")
        expect(() => reader.returnToParentBranch("s")).toThrow("disposed")
    })
})

function fixture() {
    const memory = new InMemorySessionManager()
    memory.createSession({ id: "s", agentId: "buli", title: "Test", createdAt: 1, updatedAt: 1 })
    memory.appendMessage(message("A"))
    memory.saveCompactionCheckpoint({ id: "cp", sessionId: "s", createdAt: 3, reason: "manual", summary: "Parent", throughMessageId: "A", compactedMessageCount: 1 })
    memory.createBranch("s", "side")
    memory.appendMessage(message("X"))
    memory.createBranch("s", "nested")
    return memory.getSessionArchive("s")
}
function message(id: string) {
    return { id, sessionId: "s", runId: id, role: "user" as const, source: "prompt" as const, content: id, createdAt: 2 }
}
function withLog(run: (path: string, open: () => JsonlSessionManager) => void) {
    const directory = mkdtempSync(join(tmpdir(), "buli-branch-log-"))
    const path = join(directory, "session.jsonl")
    const managers: JsonlSessionManager[] = []
    try {
        run(path, () => {
            const manager = new JsonlSessionManager({ filePath: path })
            managers.push(manager)
            return manager
        })
    } finally {
        for (const manager of managers) manager.dispose()
        rmSync(directory, { recursive: true, force: true })
    }
}
function exported(manager: JsonlSessionManager) {
    const records = manager.exportSession("s").trim().split("\n").map((line) => JSON.parse(line) as TSessionRecord)
    return replaySessionRecords(records).archives[0]!
}

test("reopens nested selection, appends to its owner and preserves full archive on export and delete", () => {
    withLog((path, open) => {
        const input = fixture()
        writeFileSync(path, serializeSessionRecords(sessionArchiveRecords(input)))
        const manager = open()
        expect(manager.getMessages("s").map((item) => item.id)).toEqual(["A", "X"])
        manager.appendMessage(message("N"))
        expect(exported(manager).branches.find((data) => data.branch.id === "nested")!.messages).toEqual([message("N")])
        manager.createSession({ ...input.info, id: "other" })
        manager.appendMessage({ ...message("O"), sessionId: "other" })
        const before = exported(manager)
        manager.deleteSession("other")
        expect(exported(manager)).toEqual(before)
        manager.dispose()
        const restored = open()
        expect(exported(restored)).toEqual(before)
        expect(restored.getCompactionCheckpoint("s")?.id).toBe("cp")
    })
})

test("rejects protected writes before persistence and leaves revision unchanged", () => {
    withLog((path, open) => {
        writeFileSync(path, serializeSessionRecords(sessionArchiveRecords({ ...fixture(), activeBranchId: "main" })))
        const manager = open()
        const contents = readFileSync(path, "utf8")
        const revision = manager.getPresentationRevision("s")
        expect(() => manager.appendMessage({ ...message("A"), content: "changed" })).toThrow("inherited")
        expect(() => manager.saveCompactionCheckpoint({ id: "cp", sessionId: "s", createdAt: 3, reason: "manual", summary: "changed", throughMessageId: "A", compactedMessageCount: 1 })).toThrow("inherited")
        expect(readFileSync(path, "utf8")).toBe(contents)
        expect(manager.getPresentationRevision("s")).toBe(revision)
    })
})

test("failed append keeps active history, checkpoint and revision unchanged", () => {
    withLog((path, open) => {
        writeFileSync(path, serializeSessionRecords(sessionArchiveRecords(fixture())))
        const manager = open()
        const before = exported(manager)
        const revision = manager.getPresentationRevision("s")
        const append = spyOn(fs, "appendFileSync").mockImplementation(() => { throw new Error("disk failure") })
        try {
            expect(() => manager.appendMessage(message("N"))).toThrow("disk failure")
            expect(() => manager.saveCompactionCheckpoint({ id: "new", sessionId: "s", createdAt: 4, reason: "manual", summary: "New", throughMessageId: "X", compactedMessageCount: 2 })).toThrow("disk failure")
        } finally { append.mockRestore() }
        expect(exported(manager)).toEqual(before)
        expect(manager.getPresentationRevision("s")).toBe(revision)
    })
})

test("replay error maps to physical line and does not repair a tail after an invalid prefix", () => {
    withLog((path, open) => {
        const contents = '\n' + JSON.stringify({ recordType: "branchSelection", sessionId: "missing", branchId: "main" }) + '\n{"unfinished":'
        writeFileSync(path, contents)
        expect(open).toThrow(`line 2 in ${path}`)
        expect(readFileSync(path, "utf8")).toBe(contents)
    })
})

test("rejects old message format and releases ownership after load failure", () => {
    withLog((path, open) => {
        const session = sessionArchiveRecords(fixture())[0]!
        writeFileSync(path, JSON.stringify(session) + '\n' + JSON.stringify({ recordType: "message", message: message("A") }) + '\n')
        expect(open).toThrow("line 2")
        writeFileSync(path, serializeSessionRecords(sessionArchiveRecords(fixture())))
        expect(open().getMessages("s")).toHaveLength(2)
    })
})
