import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { IAssistantMessage, IUserMessage } from "@/agent"
import type { ICompactionCheckpoint } from "@/sessions/compaction/checkpoint"
import type { TStoredMessage } from "@/sessions/history-contracts"
import { SQLiteSessionManager } from "@/sessions/sqlite/sqlite-session-manager"

const info = { id: "s", agentId: "buli", title: "History", createdAt: 1, updatedAt: 1 }
function user(id: string, createdAt = 2): IUserMessage {
    return { id, sessionId: "s", runId: "r", role: "user", source: "prompt", content: id, createdAt }
}
function assistant(id: string, calls = 0): IAssistantMessage {
    return { id, sessionId: "s", runId: "r", role: "assistant", stopReason: calls ? "toolUse" : "stop", createdAt: 3,
        content: calls ? Array.from({ length: calls }, (_, index) => ({ type: "toolCall" as const,
            toolCallId: `${id}-call-${index}`, toolName: "test", input: { index } })) : [{ type: "text", text: id }] }
}
function result(owner: string, index = 0, id = `${owner}-result-${index}`): TStoredMessage {
    return { id, sessionId: "s", runId: "r", role: "toolResult", assistantMessageId: owner,
        toolCallId: `${owner}-call-${index}`, toolName: "test", content: "complete", isError: false, createdAt: 4 }
}
function checkpoint(id: string, throughMessageId: string, compactedMessageCount: number): ICompactionCheckpoint {
    return { id, sessionId: "s", throughMessageId, compactedMessageCount, summary: `Full summary ${id}`,
        reason: "manual", createdAt: 5 }
}
function withManager(run: (manager: SQLiteSessionManager) => void): void {
    const manager = new SQLiteSessionManager({ databasePath: ":memory:" })
    let failure: { cause: unknown } | undefined
    try { manager.createSession(info); run(manager) } catch (cause) { failure = { cause } }
    try { manager.dispose() } catch (cause) {
        if (failure) throw new AggregateError([failure.cause, cause], "History test and cleanup failed")
        throw cause
    }
    if (failure) throw failure.cause
}

describe("SQLite session history", () => {
    test("rolls back only an empty session and retains ownership until explicit release", () => withManager((manager) => {
        expect(manager.deleteEmptySession("s")).toBe(true)
        expect(manager.getSessionInfo("s")).toBeUndefined()
        manager.releaseSession("s")
        manager.createSession(info)
        expect(manager.loadHistoryPage("s", "main").messages).toEqual([])
    }))

    test.each(["main", "side"])("never rolls back committed messages on %s", (branch) => withManager((manager) => {
        if (branch === "side") manager.createBranch("s", "side")
        manager.appendMessage(assistant("saved"))
        manager.saveCompactionCheckpoint(checkpoint("saved-summary", "saved", 1))
        if (branch === "side") manager.returnToParentBranch("s")
        expect(manager.deleteEmptySession("s")).toBe(false)
        expect(manager.getSessionInfo("s")).toBeDefined()
        expect(manager.loadHistoryPage("s", branch).messages).toHaveLength(1)
        expect(manager.loadHistoryPage("s", branch).checkpoint?.id).toBe("saved-summary")
    }))

    test("stores immutable messages and monotonic metadata without an archive cache", () => withManager((manager) => {
        manager.appendMessage(user("a", 10))
        expect(manager.appendMessage(user("a", 10))).toEqual({ kind: "unchanged" })
        manager.appendMessage(user("b", 3))
        expect(manager.getSessionInfo("s")?.updatedAt).toBe(10)
        expect(() => manager.appendMessage({ ...user("a", 10), content: "changed" })).toThrow("immutable")
        expect(manager.loadHistoryPage("s", "main").messages.map((message) => message.id)).toEqual(["a", "b"])
        const returned = manager.loadHistoryPage("s", "main").messages[0] as { content: string }
        returned.content = "mutated"
        expect(manager.loadHistoryPage("s", "main").messages[0]).toMatchObject({ content: "a" })
    }))

    test("requires calls and matching visible ownership before storing results", () => withManager((manager) => {
        manager.appendMessage(user("u"))
        expect(() => manager.appendMessage(result("a"))).toThrow()
        manager.appendMessage(assistant("a", 2))
        expect(() => manager.appendMessage(user("too-early"))).toThrow("pending tool group")
        expect(() => manager.appendMessage({ ...result("a"), runId: "other" })).toThrow("pending assistant")
        expect(() => manager.appendMessage({ ...result("a"), toolName: "wrong" } as TStoredMessage)).toThrow("match its call")
        manager.appendMessage(result("a", 1))
        expect(() => manager.appendMessage(result("a", 1, "duplicate"))).toThrow("Duplicate")
        manager.appendMessage(result("a"))
        manager.appendMessage(user("next"))
        expect(manager.loadRequiredContext("s").messages).toHaveLength(5)
    }))

    test("returns all required messages even when the UI page contains only 500", () => withManager((manager) => {
        for (let index = 0; index < 550; index++) manager.appendMessage(user(`u${index}`))
        const latest = manager.loadHistoryPage("s", "main")
        expect(latest.messages).toHaveLength(500)
        expect(latest.messages[0]?.id).toBe("u50")
        expect(latest.olderCursor).toEqual({ sessionId: "s", branchId: "main", beforeMessageId: "u50" })
        const older = manager.loadHistoryPage("s", "main", latest.olderCursor)
        expect(older.messages).toHaveLength(50)
        expect(older.olderCursor).toBeUndefined()
        expect(manager.loadRequiredContext("s").messages).toHaveLength(550)
    }))

    test("keeps whole groups at the target and admits an oversized first group", () => withManager((manager) => {
        manager.appendMessage(assistant("a", 3))
        for (let index = 0; index < 3; index++) manager.appendMessage(result("a", index))
        for (let index = 0; index < 498; index++) manager.appendMessage(user(`u${index}`))
        const latest = manager.loadHistoryPage("s", "main")
        expect(latest.messages).toHaveLength(498)
        expect(manager.loadHistoryPage("s", "main", latest.olderCursor).messages).toHaveLength(4)
        manager.appendMessage(assistant("huge", 1_199))
        for (let index = 0; index < 1_199; index++) manager.appendMessage(result("huge", index))
        const oversized = manager.loadHistoryPage("s", "main")
        expect(oversized.messages).toHaveLength(1_200)
        expect(oversized.messages[0]?.id).toBe("huge")
    }))

    test("isolates parent, sibling and nested histories and rejects foreign cursors", () => withManager((manager) => {
        manager.appendMessage(user("A"))
        manager.appendMessage(assistant("B"))
        manager.createBranch("s", "side")
        manager.appendMessage(user("X"))
        manager.createBranch("s", "nested")
        manager.appendMessage(user("P"))
        expect(manager.loadRequiredContext("s").messages.map((message) => message.id)).toEqual(["A", "B", "X", "P"])
        manager.returnToParentBranch("s")
        manager.appendMessage(user("Y"))
        manager.returnToParentBranch("s")
        manager.appendMessage(user("C"))
        expect(manager.loadHistoryPage("s", "nested").messages.map((message) => message.id)).toEqual(["A", "B", "X", "P"])
        expect(() => manager.loadHistoryPage("s", "side", { sessionId: "s", branchId: "main", beforeMessageId: "B" })).toThrow("another")
        expect(() => manager.loadHistoryPage("s", "side", { sessionId: "s", branchId: "side", beforeMessageId: "C" })).toThrow("not visible")
    }))

    test("selects exact inherited summaries and does not reorder identical checkpoint retries", () => withManager((manager) => {
        manager.appendMessage(user("A"))
        manager.appendMessage(assistant("B"))
        const first = checkpoint("first", "B", 2)
        const second = checkpoint("second", "B", 2)
        manager.saveCompactionCheckpoint(first)
        manager.saveCompactionCheckpoint(second)
        manager.saveCompactionCheckpoint(first)
        expect(manager.getCompactionCheckpoint("s")?.id).toBe("second")
        manager.createBranch("s", "side")
        manager.appendMessage(user("X"))
        expect(manager.loadRequiredContext("s")).toMatchObject({ contextSummary: second.summary, messages: [user("X")] })
        manager.returnToParentBranch("s")
        manager.appendMessage(assistant("C"))
        manager.saveCompactionCheckpoint(checkpoint("third", "C", 3))
        expect(manager.loadHistoryPage("s", "side").checkpoint?.id).toBe("second")
        expect(() => manager.saveCompactionCheckpoint({ ...second, summary: "replacement" })).toThrow("immutable")
    }))

    test("does not apply an unprocessed-user checkpoint or truncate a long suffix", () => withManager((manager) => {
        manager.appendMessage(user("A"))
        manager.saveCompactionCheckpoint(checkpoint("premature", "A", 1))
        expect(manager.loadRequiredContext("s").contextSummary).toBeUndefined()
        manager.appendMessage(assistant("B"))
        manager.saveCompactionCheckpoint(checkpoint("valid", "B", 2))
        for (let index = 0; index < 1_020; index++) manager.appendMessage(user(`suffix-${index}`))
        const context = manager.loadRequiredContext("s")
        expect(context.contextSummary).toBe("Full summary valid")
        expect(context.messages).toHaveLength(1_020)
        expect(context.messages[0]?.id).toBe("suffix-0")
    }))

    test("deletes an entire session atomically, without deleting other sessions", () => withManager((manager) => {
        manager.appendMessage(assistant("a", 1))
        manager.appendMessage(result("a"))
        manager.saveCompactionCheckpoint(checkpoint("cp", "a-result-0", 2))
        manager.createBranch("s", "side")
        manager.appendMessage(user("side-message"))
        manager.createSession({ ...info, id: "other" })
        manager.deleteSession("s")
        expect(manager.listSessions().map((session) => session.id)).toEqual(["other"])
        manager.releaseSession("s")
        manager.createSession(info)
        expect(manager.loadRequiredContext("s").messages).toEqual([])
    }))

    test("retains full large payloads without the retired byte target", () => withManager((manager) => {
        const content = "pełna treść 🐂".repeat(800_000)
        manager.appendMessage({ ...user("large"), content })
        expect(manager.loadHistoryPage("s", "main").messages[0]).toMatchObject({ content })
    }))

    test("recovers only missing final results with explicit owners and collision-safe IDs", () => withManager((manager) => {
        manager.appendMessage(user("recovered-a-a-call-1"))
        manager.appendMessage(assistant("a", 3))
        manager.appendMessage(result("a", 0))
        expect(manager.loadHistoryPage("s", "main").messages).toHaveLength(3)
        expect(() => manager.createBranch("s", "unfinished")).toThrow("unfinished")
        manager.recoverInterruptedTools("s")
        const messages = manager.loadRequiredContext("s").messages
        expect(messages).toHaveLength(5)
        expect(messages[3]).toMatchObject({ id: "recovered-a-a-call-1-1", assistantMessageId: "a", toolCallId: "a-call-1",
            outcome: "effects-unknown", isError: true })
        expect(messages[4]).toMatchObject({ assistantMessageId: "a", toolCallId: "a-call-2", outcome: "effects-unknown" })
        manager.recoverInterruptedTools("s")
        expect(manager.loadRequiredContext("s").messages).toEqual(messages)
        manager.appendMessage(user("next"))
        expect(() => manager.loadHistoryPage("s", "main", {
            sessionId: "s", branchId: "main", beforeMessageId: "a-result-0",
        })).toThrow("splits a tool group")
    }))

    test("loads the recent tool conversation across a compaction boundary without sibling leakage", () => withManager((manager) => {
        manager.appendMessage(user("oldest"))
        manager.appendMessage(user("previous"))
        manager.appendMessage(assistant("between", 1))
        manager.appendMessage(result("between"))
        manager.appendMessage(assistant("answer"))
        manager.saveCompactionCheckpoint(checkpoint("cp", "answer", 5))
        manager.createBranch("s", "side")
        manager.appendMessage(user("current"))
        manager.appendMessage(assistant("after-current"))
        expect(manager.loadRequiredContext("s").messages.map((message) => message.id)).toEqual(["current", "after-current"])
        expect(manager.loadRecentConversation("s").map((message) => message.id)).toEqual(["previous", "between", "answer", "current"])
        manager.returnToParentBranch("s")
        manager.appendMessage(user("parent-current"))
        expect(manager.loadRecentConversation("s").map((message) => message.id)).toEqual(["previous", "between", "answer", "parent-current"])
    }))

    test("loads selected paths across compaction, retaining the latest 500 unique references in order", () => withManager((manager) => {
        const reference = (index: number) => ({ type: "path" as const, kind: "file" as const, path: `/workspace/${index}`,
            source: { value: "file", start: 0, end: 4 } })
        for (let index = 0; index < 510; index++) manager.appendMessage({ ...user(`u${index}`), content: "file", references: [reference(index)] })
        manager.appendMessage(assistant("answer"))
        manager.saveCompactionCheckpoint(checkpoint("cp", "answer", 511))
        manager.appendMessage({ ...user("again"), content: "file", references: [reference(20), reference(20)] })
        const paths = manager.loadSelectedPaths("s")
        expect(paths).toHaveLength(500)
        expect(paths[0]?.path).toBe("/workspace/10")
        expect(paths.at(-1)?.path).toBe("/workspace/20")
        expect(paths.filter((path) => path.path === "/workspace/20")).toHaveLength(1)
        expect(manager.loadRequiredContext("s").messages).toHaveLength(1)
    }))

    test("coordinates ownership and fresh listing across file connections", async () => {
        const directoryPath = await mkdtemp(join(tmpdir(), "buli-sqlite-owners-"))
        const first = new SQLiteSessionManager({ directoryPath })
        const second = new SQLiteSessionManager({ directoryPath })
        try {
            first.createSession(info)
            first.appendMessage(user("a"))
            expect(second.listSessions()).toEqual([{ ...info, updatedAt: 2 }])
            expect(() => second.openSession("s")).toThrow("Unable to lock session")
            second.createSession({ ...info, id: "other" })
            first.releaseSession("s")
            second.openSession("s")
            expect(second.loadRequiredContext("s").messages).toEqual([user("a")])
            const db = new Database(join(directoryPath, "sessions.sqlite"))
            try { expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]) }
            finally { db.close() }
        } finally {
            first.dispose(); second.dispose()
            await rm(directoryPath, { recursive: true, force: true })
        }
    })
})
