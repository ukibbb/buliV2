import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import type { IBuliApplication } from "@/app/contracts"
import { BuliRuntimeProvider } from "@/ui/context/application-context"
import { DelegatedTaskDisplay } from "@/ui/sessions/DelegatedTaskDisplay"
import { theme } from "@/ui/terminal/theme"

test("renders ordered Explorers with bracketed model and effort and no dot separators", async () => {
    const runtime = { delegatedTasks: {
        subscribe: () => () => {}, getSnapshot: () => 0, currentTool: () => "read",
        list: () => [0, 1].map((position) => ({
            id: `task-${position}`, childSessionId: `child-${position}`, parentSessionId: "parent", assistantMessageId: "assistant",
            toolCallId: "call", position, task: `Research ${position + 1}`, modelId: "test-model", reasoningEffort: "high",
            status: position === 0 ? "running" : "completed", createdAt: 1,
        })),
    } } as unknown as IBuliApplication
    const setup = await testRender(<BuliRuntimeProvider runtime={runtime}>
        <DelegatedTaskDisplay sessionId="parent" assistantMessageId="assistant" toolCallId="call" />
    </BuliRuntimeProvider>, { width: 80, height: 14 })
    try {
        await act(async () => { await setup.renderOnce() })
        const frame = setup.captureCharFrame()
        expect(frame).toContain("Explorer 1 [test-model: high]")
        expect(frame).toContain("Explorer 2 [test-model: high]")
        expect(frame.indexOf("Explorer 1")).toBeLessThan(frame.indexOf("Explorer 2"))
        expect(frame).toContain("[w toku]")
        expect(frame).toContain("[zakończony]")
        expect(frame).toContain("Narzędzie: read")
        expect(frame).not.toContain("·")
        expect(theme.explorer).toBe("#002575")
    } finally { setup.renderer.destroy() }
})
