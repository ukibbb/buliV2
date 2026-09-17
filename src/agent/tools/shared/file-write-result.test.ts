import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyPatch } from "diff"

import type { IAgentToolContext, IAgentToolResult } from "@/agent/tool"
import { createEditTool } from "@/agent/tools/edit/edit-tool"
import { createWriteTool } from "@/agent/tools/write/write-tool"
import { createFileWriteResult } from "@/agent/tools/shared/file-write-result"

function preview(before: string | undefined, after: string, signal = new AbortController().signal) {
    return createFileWriteResult({ path: "file.txt", before, after, content: "Written", signal })
}

function structured(result: string | IAgentToolResult): IAgentToolResult {
    if (typeof result === "string") throw new Error("Expected structured result")
    return result
}

test("diff represents exact text, including Unicode, BOM, CRLF and missing newline", () => {
    for (const [before, after] of [
        ["before\n", "after\n"],
        ["\uFEFFzażółć\r\nold\r\n", "\uFEFFzażółć\r\nnew\r\n"],
        ["old", "nowy żółw"],
    ]) {
        const result = preview(before, after!)
        expect(result.outcome).toBe("completed")
        expect(applyPatch(before!, result.diff!)).toBe(after!)
    }
})

test("distinguishes new files, empty creation and unchanged content", () => {
    expect(preview(undefined, "new\n").diff).toContain("--- /dev/null")
    expect(preview(undefined, "")).toMatchObject({ summary: "Created an empty file; no text diff." })
    expect(preview("same", "same").diff).toBeUndefined()
    expect(preview("", "").summary).toBeUndefined()
})

test("omits oversized previews explicitly without changing successful outcome", () => {
    for (const [after, reason] of [
        ["x".repeat(2_000_001), "input exceeds"],
        ["x".repeat(100_001), "100 KB or 2000 lines"],
        ["x\n".repeat(2_001), "100 KB or 2000 lines"],
    ]) {
        const result = preview(undefined, after!)
        expect(result.diff).toBeUndefined()
        expect(result.summary).toContain(reason!)
        expect(result.outcome).toBe("completed")
    }
})

test("retains diff and warning when cancellation follows successful write", () => {
    const controller = new AbortController()
    controller.abort()
    const result = preview("old", "new", controller.signal)
    expect(result.outcome).toBe("committed-after-abort")
    expect(result.summary).toContain("despite cancellation")
    expect(applyPatch("old", result.diff!)).toBe("new")
})

test("write and edit return patches matching actual files", async () => {
    const root = await mkdtemp(join(tmpdir(), "buli-write-diff-"))
    const context: IAgentToolContext = {
        sessionId: "session", runId: "run", toolCallId: "call",
        signal: new AbortController().signal,
    }
    try {
        const write = createWriteTool(root)
        const edit = createEditTool(root)
        const path = "nested/file.txt"
        const initial = "\uFEFFżółw\r\nold\r\n"
        const created = structured(await write.execute({ path, content: initial }, context))
        expect(applyPatch("", created.diff!)).toBe(await readFile(join(root, path), "utf8"))
        expect(created.content).toContain(`${Buffer.byteLength(initial)} bytes`)
        const edited = structured(await edit.execute({ path, edits: [{ oldText: "old", newText: "new" }] }, context))
        const current = await readFile(join(root, path), "utf8")
        expect(applyPatch(initial, edited.diff!)).toBe(current)
        expect(current).toBe("\uFEFFżółw\r\nnew\r\n")
        const overwritten = structured(await write.execute({ path, content: "replacement" }, context))
        expect(applyPatch(current, overwritten.diff!)).toBe(await readFile(join(root, path), "utf8"))
        expect(structured(await write.execute({ path, content: "replacement" }, context)).diff).toBeUndefined()
        // A missing parent that is a regular file fails before any successful write.
        await writeFile(join(root, "blocker"), "unchanged")
        await expect(write.execute({ path: "blocker/child", content: "new" }, context)).rejects.toThrow()
        expect(await readFile(join(root, "blocker"), "utf8")).toBe("unchanged")
        const controller = new AbortController()
        controller.abort()
        await expect(write.execute({ path, content: "not written" }, { ...context, signal: controller.signal })).rejects.toThrow("aborted")
        expect(await readFile(join(root, path), "utf8")).toBe("replacement")
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})
