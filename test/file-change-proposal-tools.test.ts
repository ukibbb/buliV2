import { expect, test } from "bun:test"
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type {
    IAgentTool,
    IAgentToolContext,
    IFileChangeProposalRecord,
} from "@/agent"
import {
    createWorkspaceTools,
    FileChangeProposalStore,
} from "@/tools"

test("proposes, validates, applies, and rejects exact edit contents", async () => {
    await withFixture(async (workspace) => {
        const target = join(workspace, "example.txt")
        await writeFile(target, "before\n")

        let proposalNumber = 0
        let timestamp = 0
        const records: IFileChangeProposalRecord[] = []
        const store = new FileChangeProposalStore({
            generateId: () => `proposal-${proposalNumber += 1}`,
            now: () => timestamp += 1,
            saveProposal: (proposal) => records.push(proposal),
        })
        const tools = createWorkspaceTools(workspace, {
            fileChangeProposalStore: store,
        })
        const edit = getTool(tools, "edit")
        const apply = getTool(tools, "apply_file_changes")
        const reject = getTool(tools, "reject_file_changes")

        await expect(edit.execute({
            path: "example.txt",
            edits: [{ oldText: "before", newText: "after" }],
        }, context("run-1", "edit-1"))).resolves.toContain(
            "Proposal ID: proposal-1",
        )
        expect(await readFile(target, "utf-8")).toBe("before\n")
        expect(store.getSnapshot("session-1")?.diff).toContain(
            "-before\n+after",
        )

        await expect(apply.execute({
            proposalId: "proposal-1",
        }, context("run-1", "apply-too-early"))).rejects.toThrow(
            "cannot be applied in the run that created it",
        )

        await writeFile(target, "external change\n")
        await expect(apply.execute({
            proposalId: "proposal-1",
        }, context("run-2", "apply-stale"))).rejects.toThrow(
            "changed after the proposal was created",
        )
        expect(store.getSnapshot("session-1")?.id).toBe("proposal-1")

        await writeFile(target, "before\n")
        await expect(apply.execute({
            proposalId: "proposal-1",
        }, context("run-3", "apply-1"))).resolves.toBe(
            "Applied file-change proposal proposal-1 to example.txt.",
        )
        expect(await readFile(target, "utf-8")).toBe("after\n")
        expect(store.getSnapshot("session-1")).toBeUndefined()
        expect(records.map((proposal) => proposal.status)).toEqual([
            "pending",
            "applied",
        ])

        await expect(edit.execute({
            path: "example.txt",
            edits: [{ oldText: "after", newText: "unused" }],
        }, context("run-4", "edit-2"))).resolves.toContain(
            "Proposal ID: proposal-2",
        )
        await expect(reject.execute({
            proposalId: "proposal-2",
        }, context("run-5", "reject-2"))).resolves.toBe(
            "Rejected file-change proposal proposal-2.",
        )
        expect(await readFile(target, "utf-8")).toBe("after\n")
        expect(store.getSnapshot("session-1")).toBeUndefined()
        expect(records.map((proposal) => proposal.status)).toEqual([
            "pending",
            "applied",
            "pending",
            "rejected",
        ])
    })
})

test("proposes and applies write contents for existing and new files", async () => {
    await withFixture(async (workspace) => {
        const existing = join(workspace, "existing.txt")
        const created = join(workspace, "nested", "created.txt")
        await writeFile(existing, "before\n")

        let proposalNumber = 0
        const store = new FileChangeProposalStore(
            () => `proposal-${proposalNumber += 1}`,
        )
        const tools = createWorkspaceTools(workspace, {
            fileChangeProposalStore: store,
        })
        const write = getTool(tools, "write")
        const apply = getTool(tools, "apply_file_changes")

        await expect(write.execute({
            path: "existing.txt",
            content: "after\n",
        }, context("run-1", "write-existing"))).resolves.toContain(
            "Proposal ID: proposal-1",
        )
        expect(await readFile(existing, "utf-8")).toBe("before\n")
        expect(store.getSnapshot("session-1")).toMatchObject({
            operation: "write",
            path: "existing.txt",
        })
        expect(store.getSnapshot("session-1")?.diff).toContain(
            "-before\n+after",
        )

        await apply.execute({
            proposalId: "proposal-1",
        }, context("run-2", "apply-existing"))
        expect(await readFile(existing, "utf-8")).toBe("after\n")

        await expect(write.execute({
            path: "nested/created.txt",
            content: "created\n",
        }, context("run-3", "write-new"))).resolves.toContain(
            "Proposal ID: proposal-2",
        )
        await expect(readFile(created, "utf-8")).rejects.toThrow()
        expect(store.getForApply(
            "session-1",
            "proposal-2",
            "run-4",
        ).baseContent).toBeUndefined()

        await apply.execute({
            proposalId: "proposal-2",
        }, context("run-4", "apply-new"))
        expect(await readFile(created, "utf-8")).toBe("created\n")
    })
})

test("keeps direct edit behavior when no proposal store is configured", async () => {
    await withFixture(async (workspace) => {
        const target = join(workspace, "direct.txt")
        await writeFile(target, "before\n")
        const edit = getTool(createWorkspaceTools(workspace), "edit")

        await edit.execute({
            path: "direct.txt",
            edits: [{ oldText: "before", newText: "after" }],
        }, context("run-1", "direct-edit"))

        expect(await readFile(target, "utf-8")).toBe("after\n")
    })
})

test("rolls back file changes when applied-state persistence fails", async () => {
    await withFixture(async (workspace) => {
        const existing = join(workspace, "existing.txt")
        const created = join(workspace, "nested", "created.txt")
        await writeFile(existing, "before\n")

        let proposalNumber = 0
        let failApplied = true
        const store = new FileChangeProposalStore({
            generateId: () => `proposal-${proposalNumber += 1}`,
            saveProposal: (proposal) => {
                if (proposal.status === "applied" && failApplied) {
                    failApplied = false
                    throw new Error("disk full")
                }
            },
        })
        const tools = createWorkspaceTools(workspace, {
            fileChangeProposalStore: store,
        })
        const edit = getTool(tools, "edit")
        const write = getTool(tools, "write")
        const apply = getTool(tools, "apply_file_changes")

        await edit.execute({
            path: "existing.txt",
            edits: [{ oldText: "before", newText: "after" }],
        }, context("run-1", "edit-existing"))
        await expect(apply.execute({
            proposalId: "proposal-1",
        }, context("run-2", "apply-existing"))).rejects.toThrow("disk full")
        expect(await readFile(existing, "utf-8")).toBe("before\n")
        expect(store.getSnapshot("session-1")?.id).toBe("proposal-1")

        await apply.execute({
            proposalId: "proposal-1",
        }, context("run-3", "retry-existing"))
        expect(await readFile(existing, "utf-8")).toBe("after\n")

        failApplied = true
        await write.execute({
            path: "nested/created.txt",
            content: "created\n",
        }, context("run-4", "write-created"))
        await expect(apply.execute({
            proposalId: "proposal-2",
        }, context("run-5", "apply-created"))).rejects.toThrow("disk full")
        await expect(readFile(created, "utf-8")).rejects.toThrow()
        expect(store.getSnapshot("session-1")?.id).toBe("proposal-2")
    })
})

test("finishes an apply retry when the target content is already present", async () => {
    await withFixture(async (workspace) => {
        const target = join(workspace, "example.txt")
        await writeFile(target, "before\n")
        const store = new FileChangeProposalStore(() => "proposal-1")
        const tools = createWorkspaceTools(workspace, {
            fileChangeProposalStore: store,
        })

        await getTool(tools, "write").execute({
            path: "example.txt",
            content: "after\n",
        }, context("run-1", "write-1"))
        await writeFile(target, "after\n")

        await expect(getTool(tools, "apply_file_changes").execute({
            proposalId: "proposal-1",
        }, context("run-2", "apply-1"))).resolves.toContain(
            "Applied file-change proposal proposal-1",
        )
        expect(store.getSnapshot("session-1")).toBeUndefined()
    })
})

test("describes direct and proposal mutation modes accurately", () => {
    const directTools = createWorkspaceTools("/workspace")
    const proposalTools = createWorkspaceTools("/workspace", {
        fileChangeProposalStore: new FileChangeProposalStore(),
    })

    expect(getTool(directTools, "edit").description).not.toContain(
        "does not modify the file",
    )
    expect(getTool(directTools, "write").description).toContain(
        "overwrites if it does",
    )
    expect(getTool(proposalTools, "edit").description).toContain(
        "does not modify the file",
    )
    expect(getTool(proposalTools, "write").description).toContain(
        "does not modify the file",
    )
})

function getTool(
    tools: readonly IAgentTool[],
    name: string,
): IAgentTool {
    const tool = tools.find((candidate) => candidate.name === name)
    if (!tool) throw new Error(`Expected ${name} tool`)
    return tool
}

function context(
    runId: string,
    toolCallId: string,
): IAgentToolContext {
    return {
        sessionId: "session-1",
        runId,
        toolCallId,
        messages: [],
        signal: new AbortController().signal,
    }
}

async function withFixture(
    run: (workspace: string) => Promise<void>,
): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "buli-file-proposal-"))
    const workspace = join(root, "workspace")
    await mkdir(workspace)
    try {
        await run(workspace)
    } finally {
        await rm(root, { recursive: true, force: true })
    }
}
