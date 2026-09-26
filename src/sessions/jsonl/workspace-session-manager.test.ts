import { expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { IUserMessage } from "@/agent"
import { WorkspaceSessionManager, type ISessionInfo } from "@/sessions"

test("workspace managers write separate conversations and retain ownership after a rejected open", async () => {
    await withWorkspace(async (directoryPath, openManager) => {
        const first = openManager()
        const second = openManager()
        first.createSession(sessionInfo("first"))
        second.createSession(sessionInfo("second"))
        first.appendMessage(userMessage("first", "first-question", "First question"))
        second.appendMessage(userMessage("second", "second-question", "Second question"))

        expect(() => second.openSession("first")).toThrow("Unable to lock session log")
        expect(() => first.openSession("second")).toThrow("Unable to lock session log")
        second.appendMessage(userMessage("second", "follow-up", "Still owned", 3))
        expect(second.getMessages("second").map((message) => message.content))
            .toEqual(["Second question", "Still owned"])
        expect(first.getMessages("first").map((message) => message.content))
            .toEqual(["First question"])
        expect((await readdir(directoryPath)).filter((name) => name.endsWith(".jsonl")))
            .toHaveLength(2)

        first.dispose()
        second.dispose()
        const restored = openManager()
        expect(restored.listSessions().map((info) => info.id).sort()).toEqual(["first", "second"])
        restored.openSession("first")
        restored.openSession("second")
        expect(restored.getMessages("first")).toEqual([
            userMessage("first", "first-question", "First question"),
        ])
        expect(restored.getMessages("second")).toEqual([
            userMessage("second", "second-question", "Second question"),
            userMessage("second", "follow-up", "Still owned", 3),
        ])
    })
})

test("workspace managers reload history after ownership is handed back", async () => {
    await withWorkspace(async (_directoryPath, openManager) => {
        const first = openManager()
        const second = openManager()
        first.createSession(sessionInfo("shared"))
        const original = userMessage("shared", "original", "Before handoff")
        first.appendMessage(original)
        const originalRevision = first.getPresentationRevision("shared")
        first.releaseSession("shared")
        expect(() => first.getMessages("shared")).toThrow("Session is not open: shared")
        expect(() => first.appendMessage(original)).toThrow("Session is not open: shared")

        second.openSession("shared")
        const later = userMessage("shared", "later", "After handoff", 4)
        second.appendMessage(later)
        first.releaseSession("shared")
        expect(() => first.openSession("shared")).toThrow("Unable to lock session log")
        second.releaseSession("shared")

        first.openSession("shared")
        expect(first.getMessages("shared")).toEqual([original, later])
        expect(first.getSessionInfo("shared")?.updatedAt).toBe(4)
        expect(first.getPresentationRevision("shared")).toBeGreaterThan(originalRevision)
        first.openSession("shared")
        expect(first.getMessages("shared")).toEqual([original, later])
    })
})

test("workspace listing takes no conversation locks and refreshes new entries only on restart", async () => {
    await withWorkspace(async (_directoryPath, openManager) => {
        const writer = openManager()
        writer.createSession(sessionInfo("existing"))
        writer.appendMessage(userMessage("existing", "question", "Existing question"))
        const observer = openManager()
        expect(observer.listSessions().map((info) => info.id)).toEqual(["existing"])
        expect(() => observer.openSession("existing")).toThrow("Unable to lock session log")
        expect(() => observer.getMessages("existing")).toThrow("Session is not open: existing")

        writer.createSession(sessionInfo("new"))
        writer.appendMessage(userMessage("new", "question", "New question"))
        expect(observer.listSessions().map((info) => info.id)).toEqual(["existing"])
        observer.dispose()
        const restarted = openManager()
        expect(restarted.listSessions().map((info) => info.id).sort()).toEqual(["existing", "new"])
        writer.releaseSession("existing")
        restarted.openSession("existing")
        expect(restarted.getMessages("existing")).toHaveLength(1)
    })
})

test("workspace managers release missing and unsaved conversations without reserving their IDs", async () => {
    await withWorkspace(async (directoryPath, openManager) => {
        const first = openManager()
        const second = openManager()
        expect(() => first.openSession("missing")).toThrow("Session does not exist: missing")
        second.createSession(sessionInfo("missing"))
        expect(() => first.createSession(sessionInfo("missing"))).toThrow("Unable to lock session log")
        expect((await readdir(directoryPath)).filter((name) => name.endsWith(".jsonl")))
            .toEqual([])
        second.releaseSession("missing")
        expect(second.listSessions()).toEqual([])
        first.createSession(sessionInfo("missing"))
        first.appendMessage(userMessage("missing", "question", "Now persisted"))
        first.releaseSession("missing")
        expect(first.listSessions().map((info) => info.id)).toEqual(["missing"])
        expect(() => second.createSession(sessionInfo("missing")))
            .toThrow("Session already exists: missing")
        first.openSession("missing")
        expect(first.getMessages("missing")).toHaveLength(1)
    })
})

test("failed conversation loads preserve other ownership and release the rejected file's lock", async () => {
    await withWorkspace(async (directoryPath, openManager) => {
        const first = openManager()
        const second = openManager()
        first.createSession(sessionInfo("target"))
        const original = userMessage("target", "question", "Original question")
        first.appendMessage(original)
        first.releaseSession("target")
        const fileName = (await readdir(directoryPath)).find((name) => name.endsWith(".jsonl"))
        if (!fileName) throw new Error("Expected the persisted target conversation")
        const filePath = join(directoryPath, fileName)
        const originalContents = await readFile(filePath, "utf8")
        first.createSession(sessionInfo("current"))

        const wrongSessionRecord = JSON.stringify({
            recordType: "session", session: sessionInfo("wrong"),
        }) + "\n"
        for (const [contents, expectedError] of [
            ["not-json\n", "Invalid session JSONL record on line 1"],
            [wrongSessionRecord, "Unexpected session metadata in conversation file: target"],
            [originalContents + wrongSessionRecord, "Unexpected session metadata in conversation file: target"],
        ] as const) {
            await writeFile(filePath, contents)
            expect(() => first.openSession("target")).toThrow(expectedError)
            expect(() => first.getMessages("target")).toThrow("Session is not open: target")
            expect(() => second.openSession("current")).toThrow("Unable to lock session log")
            expect(await readFile(filePath, "utf8")).toBe(contents)

            await writeFile(filePath, originalContents)
            second.openSession("target")
            expect(second.getMessages("target")).toEqual([original])
            second.releaseSession("target")
        }
        first.appendMessage(userMessage("current", "still-owned", "Current conversation survives"))
        expect(first.getMessages("current")).toHaveLength(1)
    })
})

test("workspace startup rejects malformed and mismatched conversation files without rewriting them", async () => {
    await withWorkspace(async (directoryPath, openManager) => {
        const writer = openManager()
        writer.createSession(sessionInfo("target"))
        const original = userMessage("target", "question", "Original question")
        writer.appendMessage(original)
        writer.releaseSession("target")
        const fileName = (await readdir(directoryPath)).find((name) => name.endsWith(".jsonl"))
        if (!fileName) throw new Error("Expected the persisted target conversation")
        const filePath = join(directoryPath, fileName)
        const originalContents = await readFile(filePath, "utf8")
        const wrongSessionRecord = JSON.stringify({
            recordType: "session", session: sessionInfo("wrong"),
        }) + "\n"
        for (const [contents, expectedError] of [
            ["not-json\n", "Invalid session JSONL record on line 1"],
            [wrongSessionRecord, "Invalid conversation file"],
            [originalContents + wrongSessionRecord, "Invalid conversation file"],
        ] as const) {
            await writeFile(filePath, contents)
            expect(() => openManager()).toThrow(expectedError)
            expect(await readFile(filePath, "utf8")).toBe(contents)
        }
        await writeFile(filePath, originalContents)
        const restored = openManager()
        restored.openSession("target")
        expect(restored.getMessages("target")).toEqual([original])
    })
})

test("empty branches survive release and ownership handoff with navigation revisions", async () => {
    await withWorkspace(async (_directory, openManager) => {
        const first = openManager()
        first.createSession(sessionInfo("s"))
        const initial = first.getPresentationRevision("s")
        first.createBranch("s", "side")
        expect(first.getPresentationRevision("s")).toBeGreaterThan(initial)
        const second = openManager()
        expect(() => second.openSession("s")).toThrow("Unable to lock")
        first.releaseSession("s")
        expect(first.listSessions().map((info) => info.id)).toEqual(["s"])
        expect(() => first.createBranch("s", "nested")).toThrow("not open")
        expect(() => first.returnToParentBranch("s")).toThrow("not open")
        expect(() => first.getActiveBranchId("s")).toThrow("not open")
        second.openSession("s")
        expect(second.getActiveBranchId("s")).toBe("side")
        const revision = second.getPresentationRevision("s")
        second.returnToParentBranch("s")
        expect(second.getPresentationRevision("s")).toBeGreaterThan(revision)
        const returned = second.getPresentationRevision("s")
        expect(() => second.returnToParentBranch("s")).toThrow()
        expect(second.getPresentationRevision("s")).toBe(returned)
        second.releaseSession("s")
        first.openSession("s")
        expect(first.getActiveBranchId("s")).toBe("main")
    })
})

test("workspace keeps staged status and revisions after failed branch writes", async () => {
    await withWorkspace(async (_directory, openManager) => {
        const manager = openManager()
        manager.createSession(sessionInfo("s"))
        const revision = manager.getPresentationRevision("s")
        const rename = spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("disk failure") })
        try {
            expect(() => manager.createBranch("s", "side")).toThrow("disk failure")
        } finally { rename.mockRestore() }
        expect(manager.getActiveBranchId("s")).toBe("main")
        expect(manager.getPresentationRevision("s")).toBe(revision)
        manager.releaseSession("s")
        expect(manager.listSessions()).toEqual([])
        manager.createSession(sessionInfo("s"))
        manager.createBranch("s", "side")
        const persistedRevision = manager.getPresentationRevision("s")
        const append = spyOn(fs, "appendFileSync").mockImplementation(() => { throw new Error("disk failure") })
        try {
            expect(() => manager.createBranch("s", "nested")).toThrow("disk failure")
            expect(() => manager.returnToParentBranch("s")).toThrow("disk failure")
        } finally { append.mockRestore() }
        expect(manager.getActiveBranchId("s")).toBe("side")
        expect(manager.getPresentationRevision("s")).toBe(persistedRevision)
    })
})

async function withWorkspace(
    run: (directoryPath: string, openManager: () => WorkspaceSessionManager) => Promise<void>,
): Promise<void> {
    const directoryPath = await mkdtemp(join(tmpdir(), "buli-workspace-sessions-"))
    const managers: WorkspaceSessionManager[] = []
    try {
        await run(directoryPath, () => {
            const manager = new WorkspaceSessionManager({ directoryPath })
            managers.push(manager)
            return manager
        })
    } finally {
        try {
            const errors: unknown[] = []
            for (const manager of managers) {
                try {
                    manager.dispose()
                } catch (error) {
                    errors.push(error)
                }
            }
            if (errors.length > 0) throw new AggregateError(errors, "Test manager cleanup failed")
        } finally {
            await rm(directoryPath, { recursive: true, force: true })
        }
    }
}

function sessionInfo(id: string): ISessionInfo {
    return { id, agentId: "test-agent", title: id, createdAt: 1, updatedAt: 1 }
}

function userMessage(
    sessionId: string,
    id: string,
    content: string,
    createdAt = 2,
): IUserMessage {
    return { id, sessionId, runId: "run-1", role: "user", source: "prompt", content, createdAt }
}
