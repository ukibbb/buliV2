import { expect, test } from "bun:test"

import type { IFileChangeProposalRecord } from "@/agent"
import { FileChangeProposalStore } from "@/tools"

test("stores one immutable public proposal per session", () => {
    const store = new FileChangeProposalStore(() => "proposal-1")
    const proposal = store.propose({
        sessionId: "session-1",
        runId: "run-1",
        toolCallId: "call-1",
        operation: "edit",
        path: "src/example.ts",
        baseContent: "const value = 1\n",
        targetContent: "const value = 2\n",
        diff: "--- a/src/example.ts\n+++ b/src/example.ts\n",
    })

    expect(proposal).toEqual({
        id: "proposal-1",
        sessionId: "session-1",
        runId: "run-1",
        toolCallId: "call-1",
        operation: "edit",
        path: "src/example.ts",
        diff: "--- a/src/example.ts\n+++ b/src/example.ts\n",
    })
    expect(store.getSnapshot("session-1")).toEqual(proposal)
    expect(Object.isFrozen(proposal)).toBe(true)
    expect(proposal).not.toHaveProperty("baseContent")
    expect(proposal).not.toHaveProperty("targetContent")
})

test("persists pending and resolved states without private contents", () => {
    const records: IFileChangeProposalRecord[] = []
    let timestamp = 0
    const store = new FileChangeProposalStore({
        generateId: () => "proposal-1",
        now: () => timestamp += 1,
        saveProposal: (proposal) => records.push(proposal),
    })

    store.propose(proposalInput("session-1", "example.ts"))
    store.resolve("session-1", "proposal-1", "applied")

    expect(records).toEqual([
        {
            id: "proposal-1",
            sessionId: "session-1",
            runId: "run-1",
            toolCallId: "call-1",
            operation: "edit",
            path: "example.ts",
            diff: "--- a/example.ts\n+++ b/example.ts\n",
            status: "pending",
            createdAt: 1,
        },
        {
            id: "proposal-1",
            sessionId: "session-1",
            runId: "run-1",
            toolCallId: "call-1",
            operation: "edit",
            path: "example.ts",
            diff: "--- a/example.ts\n+++ b/example.ts\n",
            status: "applied",
            createdAt: 1,
            resolvedAt: 2,
        },
    ])
    expect(records[0]).not.toHaveProperty("baseContent")
    expect(records[0]).not.toHaveProperty("targetContent")
})

test("expires a replaced proposal before persisting its replacement", () => {
    const records: IFileChangeProposalRecord[] = []
    let id = 0
    let timestamp = 0
    const store = new FileChangeProposalStore({
        generateId: () => `proposal-${id += 1}`,
        now: () => timestamp += 1,
        saveProposal: (proposal) => records.push(proposal),
    })

    store.propose(proposalInput("session-1", "first.ts"))
    const replacement = store.propose(
        proposalInput("session-1", "replacement.ts"),
    )

    expect(records.map(({ id: proposalId, status }) => ({
        id: proposalId,
        status,
    }))).toEqual([
        { id: "proposal-1", status: "pending" },
        { id: "proposal-1", status: "expired" },
        { id: "proposal-2", status: "pending" },
    ])
    expect(store.getSnapshot("session-1")).toEqual(replacement)
})

test("keeps an active proposal when resolved-state persistence fails", () => {
    const store = new FileChangeProposalStore({
        generateId: () => "proposal-1",
        now: () => 1,
        saveProposal: (proposal) => {
            if (proposal.status === "applied") throw new Error("disk full")
        },
    })
    const proposal = store.propose(proposalInput("session-1", "example.ts"))

    expect(() => store.resolve(
        "session-1",
        proposal.id,
        "applied",
    )).toThrow("disk full")
    expect(store.getSnapshot("session-1")).toEqual(proposal)
})

test("replaces only the active proposal from the same session", () => {
    let id = 0
    const store = new FileChangeProposalStore(
        () => `proposal-${id += 1}`,
    )

    store.propose(proposalInput("session-1", "first.ts"))
    store.propose(proposalInput("session-2", "other.ts"))
    const replacement = store.propose(
        proposalInput("session-1", "replacement.ts"),
    )

    expect(store.getSnapshot("session-1")).toEqual(replacement)
    expect(store.getSnapshot("session-2")).toMatchObject({
        id: "proposal-2",
        path: "other.ts",
    })
})

test("notifies only listeners of the changed session", () => {
    const store = new FileChangeProposalStore(() => "proposal-1")
    let firstNotifications = 0
    let secondNotifications = 0
    const unsubscribe = store.subscribe("session-1", () => {
        firstNotifications += 1
    })
    store.subscribe("session-2", () => {
        secondNotifications += 1
    })

    store.propose(proposalInput("session-1", "example.ts"))
    unsubscribe()
    store.resolve("session-1", "proposal-1")

    expect(firstNotifications).toBe(1)
    expect(secondNotifications).toBe(0)
})

test("returns private contents only for a later run", () => {
    const store = new FileChangeProposalStore(() => "proposal-1")
    store.propose(proposalInput("session-1", "example.ts"))

    expect(() => store.getForApply(
        "session-1",
        "proposal-1",
        "run-1",
    )).toThrow(
        "A file-change proposal cannot be applied in the run that created it.",
    )

    expect(store.getForApply(
        "session-1",
        "proposal-1",
        "run-2",
    )).toMatchObject({
        baseContent: "before\n",
        targetContent: "after\n",
    })
})

test("does not resolve a replaced proposal through a stale ID", () => {
    let id = 0
    const store = new FileChangeProposalStore(
        () => `proposal-${id += 1}`,
    )
    store.propose(proposalInput("session-1", "first.ts"))
    const replacement = store.propose(
        proposalInput("session-1", "second.ts"),
    )

    expect(() => store.resolve(
        "session-1",
        "proposal-1",
    )).toThrow("File-change proposal ID mismatch")
    expect(store.getSnapshot("session-1")).toEqual(replacement)

    store.resolve("session-1", replacement.id)
    expect(store.getSnapshot("session-1")).toBeUndefined()
})

function proposalInput(sessionId: string, path: string) {
    return {
        sessionId,
        runId: "run-1",
        toolCallId: "call-1",
        operation: "edit" as const,
        path,
        baseContent: "before\n",
        targetContent: "after\n",
        diff: `--- a/${path}\n+++ b/${path}\n`,
    }
}
