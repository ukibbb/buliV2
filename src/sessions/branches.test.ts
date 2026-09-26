import { expect, test } from "bun:test"
import type { IUserMessage } from "@/agent"
import {
    MAIN_BRANCH_ID,
    getParentBranchId,
    resolveBranchContext,
    validateSessionBranches,
    type ISessionBranchData,
} from "@/sessions/branches"
import type { ICompactionCheckpoint } from "@/sessions/compaction/checkpoint"
import { projectAgentContext } from "@/sessions/compaction/context-projector"

function message(id: string): IUserMessage {
    return {
        id, sessionId: "session", runId: `run-${id}`, role: "user",
        source: "prompt", content: id, createdAt: 1,
    }
}

function checkpoint(id: string, anchor: string, count: number): ICompactionCheckpoint {
    return {
        id, sessionId: "session", createdAt: 1, reason: "manual",
        compactedMessageCount: count, throughMessageId: anchor, summary: id,
    }
}

function branch(
    id: string,
    ids: readonly string[],
    origin: ISessionBranchData["branch"]["origin"] = null,
    checkpoints: readonly ICompactionCheckpoint[] = [],
    inheritedCheckpointId: string | null = null,
): ISessionBranchData {
    return {
        branch: { id, origin, inheritedCheckpointId },
        messages: ids.map(message), checkpoints,
    }
}

function tree(...entries: ISessionBranchData[]): Map<string, ISessionBranchData> {
    return new Map(entries.map((entry) => [entry.branch.id, entry]))
}

function origin(branchId: string, throughMessageId: string | null) {
    return { branchId, throughMessageId }
}

function ids(branches: Map<string, ISessionBranchData>, id: string) {
    return resolveBranchContext(branches, id).messages.map((message) => message.id)
}

test("main resolves linear history, including an empty session", () => {
    for (const history of [[], ["A", "B", "C"]]) {
        const branches = tree(branch(MAIN_BRANCH_ID, history))
        validateSessionBranches("session", branches)
        expect(ids(branches, MAIN_BRANCH_ID)).toEqual(history)
    }
})

test("branches inherit fixed prefixes and exclude siblings and later parent messages", () => {
    const branches = tree(
        branch(MAIN_BRANCH_ID, ["A", "B", "C", "D"]),
        branch("side", ["X", "Y"], origin(MAIN_BRANCH_ID, "C")),
        branch("sibling", ["Z"], origin(MAIN_BRANCH_ID, "B")),
        branch("nested", ["P", "Q"], origin("side", "Y")),
    )
    validateSessionBranches("session", branches)
    expect(ids(branches, "side")).toEqual(["A", "B", "C", "X", "Y"])
    expect(ids(branches, "sibling")).toEqual(["A", "B", "Z"])
    expect(ids(branches, "nested")).toEqual(["A", "B", "C", "X", "Y", "P", "Q"])
    expect(ids(branches, MAIN_BRANCH_ID)).toEqual(["A", "B", "C", "D"])
    expect(getParentBranchId(branches, "nested")).toBe("side")
    expect(getParentBranchId(branches, "side")).toBe(MAIN_BRANCH_ID)
    expect(() => getParentBranchId(branches, MAIN_BRANCH_ID)).toThrow("no return destination")
})

test("null fork anchor inherits no messages", () => {
    const branches = tree(
        branch(MAIN_BRANCH_ID, ["A"]),
        branch("side", ["X"], origin(MAIN_BRANCH_ID, null)),
    )
    expect(ids(branches, "side")).toEqual(["X"])
})

test("rejects missing parents, cycles, invalid anchors and invalid roots", () => {
    const main = branch(MAIN_BRANCH_ID, ["A"])
    const cases = [
        tree(branch("side", [], origin("missing", null))),
        tree(main, branch("side", [], origin("missing", null))),
        tree(main, branch("side", [], origin("other", null)), branch("other", [], origin("side", null))),
        tree(main, branch("side", [], origin(MAIN_BRANCH_ID, "missing"))),
        tree(main, branch("side", [])),
        tree(branch(MAIN_BRANCH_ID, [], origin("side", null))),
    ]
    for (const branches of cases) {
        expect(() => validateSessionBranches("session", branches)).toThrow()
    }
    expect(() => resolveBranchContext(tree(main), "missing")).toThrow("does not exist")
})

test("retains inherited checkpoint identity when parent is compacted again", () => {
    const old = checkpoint("old", "A", 1)
    const latest = checkpoint("latest", "B", 2)
    const branches = tree(
        branch(MAIN_BRANCH_ID, ["A", "B"], null, [old, latest]),
        branch("side", ["X"], origin(MAIN_BRANCH_ID, "B"), [], old.id),
    )
    validateSessionBranches("session", branches)
    expect(resolveBranchContext(branches, MAIN_BRANCH_ID).checkpoint).toEqual(latest)
    expect(resolveBranchContext(branches, "side").checkpoint).toEqual(old)
})

test("child compaction does not change parent context or leak through projection", () => {
    const parent = checkpoint("parent-summary", "A", 1)
    const child = checkpoint("SIDE-SECRET", "X", 3)
    const branches = tree(
        branch(MAIN_BRANCH_ID, ["A", "B"], null, [parent]),
        branch("side", ["X"], origin(MAIN_BRANCH_ID, "B"), [child], parent.id),
    )
    validateSessionBranches("session", branches)
    expect(resolveBranchContext(branches, "side").checkpoint).toEqual(child)
    const context = resolveBranchContext(branches, getParentBranchId(branches, "side"))
    expect(context.checkpoint).toEqual(parent)
    expect(JSON.stringify(projectAgentContext(context.messages, context.checkpoint)))
        .not.toContain("SIDE-SECRET")
    expect(context.messages.map((message) => message.id)).toEqual(["A", "B"])
})

test("invalid anchors fall back to older, inherited checkpoints or full history", () => {
    const good = checkpoint("good", "A", 1)
    const stale = checkpoint("stale", "missing", 2)
    const branches = tree(
        branch(MAIN_BRANCH_ID, ["A"], null, [good, stale]),
        branch("side", ["X"], origin(MAIN_BRANCH_ID, "A"), [checkpoint("bad-child", "missing", 2)], good.id),
        branch("plain", [], origin(MAIN_BRANCH_ID, "A"), [], stale.id),
    )
    validateSessionBranches("session", branches)
    expect(resolveBranchContext(branches, MAIN_BRANCH_ID).checkpoint).toEqual(good)
    expect(resolveBranchContext(branches, "side").checkpoint).toEqual(good)
    expect(resolveBranchContext(branches, "plain").checkpoint).toBeUndefined()
})

test("cannot inherit a sibling checkpoint or one beyond the fork point", () => {
    const branches = tree(
        branch(MAIN_BRANCH_ID, ["A", "B"], null, [checkpoint("later", "B", 2)]),
        branch("side", ["X"], origin(MAIN_BRANCH_ID, "A"), [checkpoint("side-summary", "X", 2)]),
        branch("other", [], origin(MAIN_BRANCH_ID, "A"), [], "side-summary"),
        branch("early", [], origin(MAIN_BRANCH_ID, "A"), [], "later"),
    )
    expect(() => resolveBranchContext(branches, "other")).toThrow("Invalid inherited checkpoint")
    expect(resolveBranchContext(branches, "early").checkpoint).toBeUndefined()
})

test("validates ownership, duplicate IDs, map identity and malformed checkpoints", () => {
    const wrongMessage = { ...message("A"), sessionId: "another" }
    const wrongCheckpoint = { ...checkpoint("cp", "A", 1), sessionId: "another" }
    const base = branch(MAIN_BRANCH_ID, ["A"])
    const cases = [
        tree({ ...base, messages: [wrongMessage] }),
        tree({ ...base, checkpoints: [wrongCheckpoint] }),
        tree(base, branch("side", ["A"], origin(MAIN_BRANCH_ID, "A"))),
        tree({ ...base, checkpoints: [checkpoint("cp", "A", 1), checkpoint("cp", "A", 1)] }),
        new Map([[MAIN_BRANCH_ID, branch("wrong", [])]]),
        tree({ ...base, checkpoints: [{ ...checkpoint("cp", "A", 1), summary: "" }] }),
    ]
    for (const branches of cases) {
        expect(() => validateSessionBranches("session", branches)).toThrow()
    }
})

test("resolution does not mutate inputs and returned payloads are defensive", () => {
    const branches = tree(branch(MAIN_BRANCH_ID, ["A"], null, [checkpoint("cp", "A", 1)]))
    const before = structuredClone(branches)
    const context = resolveBranchContext(branches, MAIN_BRANCH_ID)
    ;(context.messages[0] as { content: string }).content = "changed"
    ;(context.checkpoint as { summary: string }).summary = "changed"
    expect(branches).toEqual(before)
})

test("walks deeply nested branches without recursive stack growth", () => {
    const branches = tree(branch(MAIN_BRANCH_ID, []))
    let parent = MAIN_BRANCH_ID
    for (let index = 0; index < 12_000; index++) {
        const id = `side-${index}`
        branches.set(id, branch(id, [], origin(parent, null)))
        parent = id
    }
    expect(resolveBranchContext(branches, parent).messages).toEqual([])
})
