import { expect, spyOn, test } from "bun:test"
import { CodeRenderable, DiffRenderable, RGBA, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { act, useState, type ComponentProps } from "react"
import * as diffLibrary from "diff"

import { FileChangeDiff } from "@/ui/sessions/FileChangeDiff"
import { ToolCallDisplay } from "@/ui/sessions/ToolCallDisplay"
import { theme } from "@/ui/terminal/theme"

const patch = "--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-const value = 'before'\n+const value = 'after'\n"

function codeBlocks(root: Renderable): CodeRenderable[] {
    return root.getChildren().flatMap(child => [
        ...(child instanceof CodeRenderable ? [child] : []),
        ...codeBlocks(child),
    ])
}

test.each([
    [patch, undefined, "typescript"],
    [patch, "example.py", "python"],
    [patch.replaceAll("example.ts", "example.unknown_extension"), undefined, undefined],
    [patch.replace("+++ b/example.ts", "+++ /dev/null"), undefined, "typescript"],
    ["malformed", undefined, undefined],
    [patch + patch, undefined, undefined],
] as const)("resolves language safely (%s, %s)", async (diff, path, expected) => {
    const setup = await testRender(<FileChangeDiff diff={diff} {...(path === undefined ? {} : { path })} />,
        { width: 80, height: 16 })
    try {
        await act(async () => { await setup.renderOnce() })
        const node = setup.renderer.root.getChildren()[0]
        expect(node).toBeInstanceOf(DiffRenderable)
        expect((node as DiffRenderable).filetype).toBe(expected)
        expect((node as DiffRenderable).diff).toBe(diff)
    } finally {
        act(() => setup.renderer.destroy())
    }
})

test("reuses inferred paths until the diff or explicit path changes", async () => {
    const parse = spyOn(diffLibrary, "parsePatch")
    let update!: (props: ComponentProps<typeof FileChangeDiff>) => void
    function Harness() {
        const [props, setProps] = useState<ComponentProps<typeof FileChangeDiff>>({ diff: patch })
        update = setProps
        return <FileChangeDiff {...props} />
    }
    let setup: Awaited<ReturnType<typeof testRender>> | undefined
    try {
        setup = await testRender(<Harness />, { width: 80, height: 16 })
        expect(parse).toHaveBeenCalledTimes(1)
        await act(async () => { update({ diff: patch }) })
        expect(parse).toHaveBeenCalledTimes(1)
        const changed = patch.replaceAll("example.ts", "example.py")
        await act(async () => { update({ diff: changed }) })
        expect(parse).toHaveBeenCalledTimes(2)
        expect((setup.renderer.root.getChildren()[0] as DiffRenderable).filetype).toBe("python")
        await act(async () => { update({ diff: changed, path: "explicit.ts" }) })
        expect(parse).toHaveBeenCalledTimes(2)
        expect((setup.renderer.root.getChildren()[0] as DiffRenderable).filetype).toBe("typescript")
        await act(async () => { update({ diff: changed }) })
        expect(parse).toHaveBeenCalledTimes(3)
        expect((setup.renderer.root.getChildren()[0] as DiffRenderable).filetype).toBe("python")
    } finally {
        const renderer = setup?.renderer
        if (renderer) act(() => renderer.destroy())
        parse.mockRestore()
    }
})

test.each(["edit", "write"])("colors code in the actual %s result display", async (toolName) => {
    const setup = await testRender(<ToolCallDisplay result={{
        id: "result", sessionId: "session", runId: "run", createdAt: 1,
        role: "toolResult", assistantMessageId: "assistant", toolCallId: "call", toolName,
        content: "Written", isError: false, diff: patch,
    }} />, { width: 80, height: 16 })
    try {
        await act(async () => {
            await setup.renderOnce()
            await Promise.all(codeBlocks(setup.renderer.root).map(code => code.highlightingDone))
            await setup.renderOnce()
        })
        expect(codeBlocks(setup.renderer.root).some(code => code.filetype === "typescript")).toBe(true)
        const spans = setup.captureSpans().lines.flatMap(line => line.spans)
        expect(spans.some(span => span.text.includes("const") && span.fg.equals(RGBA.fromHex(theme.pink)))).toBe(true)
        expect(spans.some(span => span.text.includes("after") && span.fg.equals(RGBA.fromHex(theme.green)))).toBe(true)
        expect(setup.captureCharFrame()).toContain("before")
        expect(setup.captureCharFrame()).toContain("after")
    } finally {
        act(() => setup.renderer.destroy())
    }
})
