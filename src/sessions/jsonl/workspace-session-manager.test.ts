import { expect, test } from "bun:test"
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
            recordType: "session", version: 2, session: sessionInfo("wrong"),
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
            recordType: "session", version: 2, session: sessionInfo("wrong"),
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
