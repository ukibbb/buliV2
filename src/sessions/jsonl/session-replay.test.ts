import { expect, test } from "bun:test"
import { resolveBranchContext } from "@/sessions/branches"
import { SessionRecordType as Kind, type TSessionRecord } from "@/sessions/jsonl/session-records"
import { replaySessionRecords } from "@/sessions/jsonl/session-replay"

function session(id = "s"): TSessionRecord {
    return { recordType: Kind.Session, session: { id, agentId: "buli", title: "Test", createdAt: 1, updatedAt: 1 } }
}
function message(id: string, branchId = "main", content = id, sessionId = "s"): TSessionRecord {
    return { recordType: Kind.Message, branchId, message: {
        id, sessionId, runId: id, role: "user", source: "prompt", content, createdAt: 2,
    } }
}
function branch(id: string, parent = "main", anchor: string | null = "A", cp: string | null = null): TSessionRecord {
    return { recordType: Kind.Branch, sessionId: "s", branch: {
        id, origin: { branchId: parent, throughMessageId: anchor }, inheritedCheckpointId: cp,
    } }
}
function select(branchId: string): TSessionRecord {
    return { recordType: Kind.BranchSelection, sessionId: "s", branchId }
}
function checkpoint(id: string, branchId = "main", anchor = "A", count = 1, summary = id): TSessionRecord {
    return { recordType: Kind.Compaction, branchId, checkpoint: {
        id, sessionId: "s", createdAt: 3, reason: "manual", summary,
        throughMessageId: anchor, compactedMessageCount: count,
    } }
}
function context(records: readonly TSessionRecord[], branchId?: string) {
    const archive = replaySessionRecords(records).archives[0]!
    return resolveBranchContext(new Map(archive.branches.map((data) => [data.branch.id, data])), branchId ?? archive.activeBranchId)
}

test("empty replay and empty nested branches", () => {
    expect(replaySessionRecords([])).toEqual({ archives: [], warnings: [] })
    const records = [session(), branch("side", "main", null), branch("nested", "side", null)]
    expect(context(records)).toEqual({ branchId: "nested", messages: [] })
})

test("restores nested branches, explicit ownership and final selection", () => {
    const records = [session(), message("A"), branch("side"), message("X", "side"),
        branch("nested", "side", "X"), message("P", "nested"), message("B"), select("main")]
    expect(context(records).messages.map((item) => item.id)).toEqual(["A", "B"])
    expect(context(records, "nested").messages.map((item) => item.id)).toEqual(["A", "X", "P"])
    expect(replaySessionRecords(records).archives[0]!.branches).toHaveLength(3)
})

test("preserves exact inherited checkpoint and isolates child compaction", () => {
    const records = [session(), message("A"), checkpoint("parent"), branch("side", "main", "A", "parent"),
        checkpoint("new-parent"), message("X", "side"), checkpoint("child", "side", "X", 2)]
    expect(context(records).checkpoint?.id).toBe("child")
    expect(context([...records, select("main")]).checkpoint?.id).toBe("new-parent")
    expect(context(records.slice(0, 5), "side").checkpoint?.id).toBe("parent")
    expect(replaySessionRecords(records).archives[0]!.branches[0]!.checkpoints).toHaveLength(2)
})

test("replaces unshared messages and accepts identical shared writes", () => {
    const records = [session(), message("A"), branch("side"), message("A"), message("B"), message("B", "main", "changed")]
    expect(context(records, "main").messages[1]).toMatchObject({ content: "changed" })
    expect(() => replaySessionRecords([...records, message("A", "main", "changed")])).toThrow("index 6")
    expect(() => replaySessionRecords([...records, message("A", "side")])).toThrow("another branch")
})

test("protects messages inherited through an empty intermediate branch", () => {
    const records = [session(), message("A"), branch("side"), branch("nested", "side", "A")]
    expect(() => replaySessionRecords([...records, message("A", "main", "changed")])).toThrow("inherited")
})

test("protects inherited checkpoint contents and cross-branch identity", () => {
    const records = [session(), message("A"), checkpoint("cp"), branch("side", "main", "A", "cp")]
    expect(() => replaySessionRecords([...records, checkpoint("cp")])).not.toThrow()
    expect(() => replaySessionRecords([...records, checkpoint("cp", "main", "A", 1, "changed")])).toThrow("inherited")
    expect(() => replaySessionRecords([...records, checkpoint("cp", "side")])).toThrow("another branch")
})

test("retains invalid checkpoint references with warnings and falls back", () => {
    const records = [session(), message("A"), checkpoint("good"), checkpoint("bad", "main", "missing"),
        branch("side", "main", "A", "bad")]
    const result = replaySessionRecords(records)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatchObject({ recordIndex: 3, checkpointId: "bad" })
    expect(context(records, "main").checkpoint?.id).toBe("good")
    expect(context(records, "side").checkpoint).toBeUndefined()
    expect(result.archives[0]!.branches[0]!.checkpoints).toHaveLength(2)
})

test("rechecks checkpoint anchors after later message replacement", () => {
    const assistant: TSessionRecord = { recordType: Kind.Message, branchId: "main", message: {
        id: "A", sessionId: "s", runId: "r", role: "assistant", content: [],
        createdAt: 2, stopReason: "stop",
    } }
    const replaced = structuredClone(assistant)
    if (replaced.recordType !== Kind.Message || replaced.message.role !== "assistant") throw new Error("fixture")
    const withTool = { ...replaced, message: { ...replaced.message,
        content: [{ type: "toolCall" as const, toolCallId: "t", toolName: "read", input: {} }],
    } }
    const result = replaySessionRecords([session(), assistant, checkpoint("cp"), withTool])
    expect(result.warnings).toHaveLength(1)
    expect(context([session(), assistant, checkpoint("cp"), withTool]).checkpoint).toBeUndefined()
})

test("rejects missing sessions, branches, fork anchors and checkpoint references", () => {
    const invalid: readonly TSessionRecord[][] = [
        [message("A")], [select("main")], [session(), select("missing")],
        [session(), message("A", "missing")], [session(), checkpoint("cp", "missing")],
        [session(), branch("side", "missing", null)], [session(), branch("side")],
        [session(), branch("side", "main", null, "missing")],
        [session(), branch("side", "side", null)],
        [session(), branch("side", "main", null), branch("side", "main", null)],
        [session(), branch("main", "main", null)],
    ]
    for (const records of invalid) expect(() => replaySessionRecords(records)).toThrow("index")
})

test("rejects inheritance of sibling checkpoints", () => {
    const records = [session(), message("A"), branch("left"), checkpoint("left-cp", "left"),
        branch("right", "main", "A", "left-cp")]
    expect(() => replaySessionRecords(records)).toThrow("index 4")
})

test("metadata updates preserve identity and monotonic timestamps across sessions", () => {
    const updated: TSessionRecord = { recordType: Kind.Session, session: {
        id: "s", agentId: "buli", title: "Renamed", createdAt: 1, updatedAt: 1,
    } }
    const result = replaySessionRecords([session(), message("A"), session("other"), message("A", "main", "Other", "other"), updated])
    expect(result.archives).toHaveLength(2)
    expect(result.archives[0]!.info).toMatchObject({ title: "Renamed", updatedAt: 2 })
    expect(result.archives[1]!.branches[0]!.messages[0]).toMatchObject({ content: "Other" })
    if (updated.recordType !== Kind.Session) throw new Error("fixture")
    for (const patch of [{ agentId: "changed" }, { createdAt: 0 }]) {
        expect(() => replaySessionRecords([session(), { ...updated, session: { ...updated.session, ...patch } }])).toThrow("identity")
    }
})

test("restores latest historical proposal and isolates input from returned archives", () => {
    const proposal: TSessionRecord = { recordType: Kind.FileChangeProposal, proposal: {
        id: "p", sessionId: "s", runId: "r", toolCallId: "t", operation: "edit",
        path: "src/example.ts", diff: "-old\n+new\n", status: "pending", createdAt: 2,
    } }
    const records = [session(), message("A"), checkpoint("cp"), branch("side"), proposal,
        { ...proposal, proposal: { ...proposal.proposal, status: "applied" as const, resolvedAt: 3 } }]
    const before = structuredClone(records)
    const result = replaySessionRecords(records)
    expect(result.archives[0]!.fileChangeProposals).toHaveLength(1)
    expect(result.archives[0]!.fileChangeProposals[0]!.status).toBe("applied")
    ;(result.archives[0]!.info as { title: string }).title = "mutated"
    ;(result.archives[0]!.branches[0]!.messages[0] as { content: string }).content = "mutated"
    ;(result.archives[0]!.branches[0]!.checkpoints[0] as { summary: string }).summary = "mutated"
    ;(result.archives[0]!.branches[1]!.branch as { id: string }).id = "mutated"
    expect(records).toEqual(before)
})

test("validates runtime record structure and reports the failing index", () => {
    const bad = { ...checkpoint("cp"), extra: true } as unknown as TSessionRecord
    expect(() => replaySessionRecords([session(), bad])).toThrow("index 1")
})
