import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { ErrorNotice } from "./ErrorNotice"
import { SessionIndicatorContent } from "./SessionIndicators"
import { collectSessionErrors } from "./SessionErrors"

const state = { isRunning: false, isCompacting: false, lastRunReason: "aborted" as const, errorMessage: "Aborted", transcriptError: "Aborted" }

test("current transcript error is shown once and suppresses generic interruption", () => {
    expect(collectSessionErrors(state, "Aborted", "Aborted")).toEqual(["Aborted"])
    expect(collectSessionErrors(state, "Different command error")).toEqual(["Aborted", "Different command error"])
    expect(collectSessionErrors({ ...state, transcriptError: undefined }, "Aborted")).toEqual(["Aborted"])
})

for (const width of [40, 80]) {
    test(`renders indicators and a wrapped error at ${width} columns`, async () => {
        const setup = await testRender(<box flexDirection="column">
            <SessionIndicatorContent activeBranchId="side" activeMcpServers={[{ serverId: "novibe", toolNames: ["list_libraries", "get_document"] }]} />
            <ErrorNotice message="A long provider error that must remain readable inside its red border" />
        </box>, { width, height: 20 })
        try {
            await act(async () => { await setup.renderOnce() })
            const frame = setup.captureCharFrame()
            expect(frame).toContain("BRANCH")
            expect(frame).toContain("NoVibe")
            expect(frame).toContain("list_libraries")
            expect(frame).toContain("get_document")
            expect(frame).toContain("┌")
            expect(frame).toContain("└")
            expect(frame.replace(/[│\s]+/g, " ")).toContain("red border")
        } finally { act(() => setup.renderer.destroy()) }
    })
}

test("active MCP with no allowed tools remains visible without a branch on main", async () => {
    const setup = await testRender(<SessionIndicatorContent activeBranchId="main" activeMcpServers={[{ serverId: "novibe", toolNames: [] }]} />, { width: 80, height: 8 })
    try {
        await act(async () => { await setup.renderOnce() })
        expect(setup.captureCharFrame()).not.toContain("BRANCH")
        expect(setup.captureCharFrame()).toContain("Brak dostępnych narzędzi")
    } finally { act(() => setup.renderer.destroy()) }
})
