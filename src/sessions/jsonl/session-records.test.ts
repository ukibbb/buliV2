import { expect, test } from "bun:test"
import {
    SessionRecordType,
    assertSessionRecord,
    parseSessionRecord,
    serializeSessionRecords,
    type TSessionRecord,
} from "@/sessions/jsonl/session-records"

const records: readonly TSessionRecord[] = [
    { recordType: SessionRecordType.Session,
        session: { id: "s", agentId: "buli", title: "Test", createdAt: 1, updatedAt: 1 } },
    { recordType: SessionRecordType.Message, branchId: "main",
        message: { id: "m", sessionId: "s", runId: "r", role: "user",
            source: "prompt", content: "Zażółć\n🦊", createdAt: 2 } },
    { recordType: SessionRecordType.Compaction, branchId: "main",
        checkpoint: { id: "cp", sessionId: "s", createdAt: 3, reason: "manual",
            summary: "Summary", throughMessageId: "m", compactedMessageCount: 1 } },
    { recordType: SessionRecordType.FileChangeProposal,
        proposal: { id: "p", sessionId: "s", runId: "r", toolCallId: "t",
            operation: "edit", path: "src/example.ts", diff: "-old\n+new\n",
            status: "pending", createdAt: 2 } },
    { recordType: SessionRecordType.Branch, sessionId: "s",
        branch: { id: "side", origin: { branchId: "main", throughMessageId: "m" },
            inheritedCheckpointId: "cp" } },
    { recordType: SessionRecordType.BranchSelection, sessionId: "s", branchId: "main" },
]

for (const record of records) {
    test(`round-trips ${record.recordType} without mutating input`, () => {
        const before = structuredClone(record)
        const serialized = serializeSessionRecords([record])
        expect(serialized.endsWith("\n")).toBe(true)
        const parsed = parseSessionRecord(serialized)
        expect(parsed).toEqual(record)
        expect(parsed).not.toBe(record)
        expect(record).toEqual(before)
    })

    test(`rejects missing and extra envelope fields for ${record.recordType}`, () => {
        for (const key of Object.keys(record)) {
            const incomplete: Record<string, unknown> = { ...record }
            delete incomplete[key]
            expect(() => assertSessionRecord(incomplete)).toThrow()
        }
        expect(() => assertSessionRecord({ ...record, extra: true })).toThrow()
        expect(() => assertSessionRecord({ ...record, version: 1 })).toThrow()
    })
}

test("serializes a JSONL stream with escaped content and a final newline", () => {
    expect(serializeSessionRecords([])).toBe("")
    const serialized = serializeSessionRecords(records)
    const lines = serialized.split("\n")
    expect(lines.pop()).toBe("")
    expect(lines).toHaveLength(records.length)
    expect(lines.map(parseSessionRecord)).toEqual([...records])
})

test("rejects malformed JSON, primitives, arrays and unknown record types", () => {
    for (const line of ["", "{", "null", "[]", "1", '"text"', '{}', '{"recordType":"unknown"}']) {
        expect(() => parseSessionRecord(line)).toThrow()
    }
})

test("rejects old message and checkpoint envelopes without branch ownership", () => {
    for (const record of records) {
        if (record.recordType !== SessionRecordType.Message
            && record.recordType !== SessionRecordType.Compaction) continue
        const { branchId: _, ...oldRecord } = record
        expect(() => parseSessionRecord(JSON.stringify(oldRecord))).toThrow()
    }
})

test("rejects invalid identifiers without silently normalizing them", () => {
    for (const id of [null, 0, false, "", " \t", [], {}]) {
        expect(() => assertSessionRecord({ ...records[1], branchId: id })).toThrow()
        expect(() => assertSessionRecord({ ...records[2], branchId: id })).toThrow()
        expect(() => assertSessionRecord({ ...records[5], sessionId: id })).toThrow()
        expect(() => assertSessionRecord({ ...records[5], branchId: id })).toThrow()
        expect(() => assertSessionRecord({ ...records[4], sessionId: id })).toThrow()
    }
})

test("validates exact nested branch fields and nullable references", () => {
    const envelope = { recordType: SessionRecordType.Branch, sessionId: "s" }
    const branch = { id: "side", origin: { branchId: "main", throughMessageId: "m" },
        inheritedCheckpointId: "cp" }
    const invalid = [
        null, [], {}, { ...branch, extra: true }, { ...branch, id: " " },
        { ...branch, inheritedCheckpointId: 1 },
        { ...branch, origin: {} },
        { ...branch, origin: { branchId: "main", throughMessageId: "m", extra: true } },
        { ...branch, origin: { branchId: "", throughMessageId: "m" } },
        { ...branch, origin: { branchId: "main", throughMessageId: "" } },
        { ...branch, origin: { branchId: "main", throughMessageId: 1 } },
    ]
    for (const value of invalid) {
        expect(() => assertSessionRecord({ ...envelope, branch: value })).toThrow()
    }
    for (const key of Object.keys(branch)) {
        const incomplete: Record<string, unknown> = { ...branch }
        delete incomplete[key]
        expect(() => assertSessionRecord({ ...envelope, branch: incomplete })).toThrow()
    }
    expect(() => assertSessionRecord({ ...envelope, branch: {
        id: "main", origin: null, inheritedCheckpointId: null,
    } })).not.toThrow()
    expect(() => assertSessionRecord({ ...envelope, branch: {
        ...branch, origin: { branchId: "main", throughMessageId: null }, inheritedCheckpointId: null,
    } })).not.toThrow()
})

test("delegates payload validation and enforces exact session metadata fields", () => {
    expect(() => assertSessionRecord({ ...records[0], session: {
        id: "s", agentId: "buli", title: "Test", createdAt: 1, updatedAt: 1, extra: true,
    } })).toThrow()
    for (const [index, field] of [[0, "session"], [1, "message"], [2, "checkpoint"], [3, "proposal"]] as const) {
        expect(() => assertSessionRecord({ ...records[index], [field]: {} })).toThrow()
    }
})

test("leaves reference existence checks to replay", () => {
    expect(() => assertSessionRecord({
        recordType: SessionRecordType.BranchSelection, sessionId: "unknown", branchId: "unknown",
    })).not.toThrow()
    expect(() => assertSessionRecord({ recordType: SessionRecordType.Branch, sessionId: "s",
        branch: { id: "side", origin: { branchId: "unknown", throughMessageId: "unknown" },
            inheritedCheckpointId: "unknown" },
    })).not.toThrow()
})

test("serialization rejects invalid runtime records instead of emitting an invalid log", () => {
    const invalid = { ...records[1], branchId: "" } as TSessionRecord
    expect(() => serializeSessionRecords([records[0]!, invalid])).toThrow()
})
