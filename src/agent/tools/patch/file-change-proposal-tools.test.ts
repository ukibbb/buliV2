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

import type { IAgentToolContext } from "@/agent"
import { createWorkspaceTools, type TWorkspaceTool } from "../../../../test/fixtures/workspace-tools"

test("edits files directly", async () => {
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

test("exposes only direct file mutation tools", () => {
    const tools = createWorkspaceTools("/workspace")

    expect(tools.map((tool) => tool.name)).toEqual([
        "read", "find", "grep", "edit", "write", "bash",
    ])
    expect(getTool(tools, "edit").description)
        .not.toContain("does not modify the file")
    expect(getTool(tools, "write").description)
        .toContain("overwrites if it does")
})

function getTool<TName extends TWorkspaceTool["name"]>(
    tools: readonly TWorkspaceTool[],
    name: TName,
): Extract<TWorkspaceTool, { readonly name: TName }>
function getTool(
    tools: readonly TWorkspaceTool[],
    name: TWorkspaceTool["name"],
): TWorkspaceTool {
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
