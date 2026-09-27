import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act, useState } from "react"

const TERMINAL_ROWS = 12
const FOOTER_ROWS = 11
const LIST_MAX_ROWS = 4
const AVAILABLE_ROWS = TERMINAL_ROWS - FOOTER_ROWS

for (const scrollable of [false, true]) {
    test(`keeps a protected footer on every notice frame (scrollable=${scrollable})`, async () => {
        let showNotice!: (show: boolean) => void
        function Fixture() {
            const [notice, setNotice] = useState(false)
            showNotice = setNotice
            const List = scrollable ? "scrollbox" : "box"
            return <box height="100%" flexDirection="column">
                <box id="panel" minHeight={0} flexShrink={1} flexDirection="column" overflow="hidden">
                    <List minHeight={0} maxHeight={LIST_MAX_ROWS} flexShrink={1} flexDirection="column">
                        {Array.from({ length: LIST_MAX_ROWS + 1 }, (_, index) => (
                            <box key={index} height={1} flexShrink={0} />
                        ))}
                    </List>
                    {notice ? <box height={1} flexShrink={0} /> : null}
                </box>
                <box id="footer" height={FOOTER_ROWS} flexShrink={0} />
            </box>
        }
        const setup = await testRender(<Fixture />, { width: 60, height: TERMINAL_ROWS })
        try {
            for (const notice of [false, true, false, true, false]) {
                act(() => showNotice(notice))
                await act(async () => { await setup.renderOnce() })
                expect(setup.renderer.root.findDescendantById("panel")!.getLayoutNode().getComputedLayout().height).toBe(AVAILABLE_ROWS)
                expect(setup.renderer.root.findDescendantById("footer")!.y).toBe(AVAILABLE_ROWS)
            }
        } finally {
            act(() => setup.renderer.destroy())
        }
    })
}
