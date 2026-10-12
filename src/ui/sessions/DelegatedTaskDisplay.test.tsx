import { expect, test } from "bun:test"
import { CodeRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import type { IAssistantMessage } from "@/agent"
import type { IBuliApplication } from "@/app/contracts"
import { BuliRuntimeProvider } from "@/ui/context/application-context"
import { DelegatedTaskDisplay } from "@/ui/sessions/DelegatedTaskDisplay"
import { Transcript } from "@/ui/sessions/Transcript"
import { createSessionTestSource } from "../../../test/fixtures/session-source"

async function fixture(transcript = false) {
    const child = createSessionTestSource({
        activeBranchId: "main", messages: [], isRunning: false, isCompacting: false,
        pendingSteeringMessages: [], pendingFollowUpMessages: [], pendingToolCallIds: [],
    })
    const runtime = { delegatedTasks: {
        subscribe: () => () => {}, getSnapshot: () => 0, currentTool: () => "read",
        open: () => child.source,
        list: () => [0, 1].map((position) => ({
            id: `task-${position}`, childSessionId: `child-${position}`, parentSessionId: "parent", assistantMessageId: "assistant",
            toolCallId: "call", position, task: `Research ${position + 1}`, modelId: "test-model", reasoningEffort: "high",
            status: position === 0 ? "running" : "completed", createdAt: 1,
            answer: "## Findings\n\n**Verified report**",
        })),
    } } as unknown as IBuliApplication
    const message: IAssistantMessage = {
        id: "assistant", sessionId: "parent", runId: "run", role: "assistant", createdAt: 1,
        content: [{ type: "toolCall", toolCallId: "call", toolName: "delegate_task", input: { tasks: [{ task: "Research 1" }] } }],
        stopReason: "tool-calls",
    }
    const setup = await testRender(<BuliRuntimeProvider runtime={runtime}>
        {transcript ? <Transcript messages={[message]} />
            : <DelegatedTaskDisplay sessionId="parent" assistantMessageId="assistant" toolCallId="call" />}
    </BuliRuntimeProvider>, { width: 80, height: 40 })
    const render = async () => { await act(async () => {
        await setup.renderOnce()
        const waitForHighlighting = async (node: Renderable): Promise<void> => {
            if (node instanceof CodeRenderable) await node.highlightingDone
            await Promise.all(node.getChildren().map(waitForHighlighting))
        }
        await waitForHighlighting(setup.renderer.root)
        await setup.renderOnce()
    }) }
    await render()
    return { setup, render }
}

test("renders compact ordered Explorers without prompts, status labels or action buttons", async () => {
    const { setup } = await fixture()
    try {
        const frame = setup.captureCharFrame()
        expect(frame).toContain("[+] Explorer 1 [test-model: high]")
        expect(frame).toContain("[+] Explorer 2 [test-model: high]")
        expect(frame.indexOf("Explorer 1")).toBeLessThan(frame.indexOf("Explorer 2"))
        for (const hidden of ["Research", "Prompt:", "Narzędzie:", "w toku", "zakończony", "Zatrzymaj", "Otwórz przebieg", "Delegate tasks"]) {
            expect(frame).not.toContain(hidden)
        }
    } finally { act(() => setup.renderer.destroy()) }
})

test("expands an indented prompt and Markdown report and collapses them again", async () => {
    const { setup, render } = await fixture()
    try {
        await act(async () => { await setup.mockMouse.click(1, 0) })
        await render()
        const frame = setup.captureCharFrame()
        expect(frame).toContain("[-] Explorer 1 [test-model: high]")
        expect(frame).toContain("    Prompt:")
        expect(frame).toContain("    Research 1")
        expect(frame).toContain("    Narzędzie: read")
        expect(frame).toContain("Findings")
        expect(frame).toContain("Verified report")
        expect(frame).not.toContain("## Findings")
        expect(frame).not.toContain("**Verified report**")
        await act(async () => { await setup.mockMouse.click(1, 0) })
        await render()
        expect(setup.captureCharFrame()).toContain("[+] Explorer 1")
        expect(setup.captureCharFrame()).not.toContain("Research 1")
    } finally { act(() => setup.renderer.destroy()) }
})

test("transcript replaces the delegation card and leaves a blank row around the Explorer group", async () => {
    const { setup } = await fixture(true)
    try {
        const rows = setup.captureCharFrame().split("\n")
        const first = rows.findIndex(row => row.includes("Explorer 1"))
        const last = rows.findIndex(row => row.includes("Explorer 2"))
        expect(first).toBe(1)
        expect(rows[first - 1]!.trim()).toBe("")
        expect(rows[last + 1]!.trim()).toBe("")
        expect(rows.join("\n")).not.toContain("Delegate tasks")
        expect(rows.join("\n")).not.toContain("delegate_task")
    } finally { act(() => setup.renderer.destroy()) }
})
