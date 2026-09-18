import { expect, test } from "bun:test"
import { CodeRenderable, RGBA, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { act, isValidElement } from "react"

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
] as const)("resolves language safely (%s, %s)", (diff, path, expected) => {
    const node = FileChangeDiff({ diff, ...(path === undefined ? {} : { path }) })
    if (!isValidElement<{ filetype?: string; diff: string }>(node)) throw new Error("Missing diff")
    expect(node.props.filetype).toBe(expected)
    expect(node.props.diff).toBe(diff)
})

test.each(["edit", "write"])("colors code in the actual %s result display", async (toolName) => {
    const setup = await testRender(<ToolCallDisplay result={{
        id: "result", sessionId: "session", runId: "run", createdAt: 1,
        role: "toolResult", toolCallId: "call", toolName,
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
