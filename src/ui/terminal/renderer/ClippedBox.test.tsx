import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"

import { ClippedBox } from "@/ui/terminal/renderer/ClippedBox"

test("clips a shrinking box at zero rows before drawing its protected sibling", async () => {
    const setup = await testRender(
        <box height="100%" flexDirection="column">
            <text height={2} flexShrink={0}>Header</text>
            <ClippedBox id="clipped-content" minHeight={0} flexShrink={1}>
                <text flexShrink={0}>Content must not bleed into footer</text>
            </ClippedBox>
            <text id="protected-footer" height={1} flexShrink={0}>Footer</text>
        </box>,
        { width: 40, height: 3 },
    )
    try {
        for (const height of [3, 4, 3, 4]) {
            act(() => setup.resize(40, height))
            await act(async () => { await setup.renderOnce() })
            const content = setup.renderer.root.findDescendantById("clipped-content")!
            const footer = setup.renderer.root.findDescendantById("protected-footer")!
            expect(content.getLayoutNode().getComputedHeight()).toBe(height - 3)
            const frame = setup.captureCharFrame()
            expect(frame.split("\n")[footer.y]!.trim()).toBe("Footer")
            expect(frame.includes("Content must not bleed into footer")).toBe(height > 3)
        }
    } finally {
        act(() => setup.renderer.destroy())
    }
})
