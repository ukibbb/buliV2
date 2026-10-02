import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import type { IAssistantMessage, TAgentMessage } from "@/agent"
import { Transcript } from "./Transcript"

function assistant(id: string, content: IAssistantMessage["content"]): IAssistantMessage {
    return { id, content, role: "assistant", runId: "run", sessionId: "session", createdAt: 1, stopReason: "stop" }
}

for (const width of [40, 80]) {
    test(`spaces visible groups across messages and live content at ${width} columns`, async () => {
        const messages: TAgentMessage[] = [
            assistant("tools", [
                { type: "toolCall", toolName: "read", toolCallId: "one", input: { path: "first.ts" } },
                { type: "toolCall", toolName: "read", toolCallId: "two", input: { path: "second.ts" } },
            ]),
            { id: "result", role: "toolResult", assistantMessageId: "tools", sessionId: "session", runId: "run", createdAt: 2,
                toolName: "read", toolCallId: "one", content: "", isError: false },
            assistant("reason-one", [{ type: "reasoning", text: "First summary" }]),
            assistant("hidden", [
                { type: "reasoning", text: " " },
                { type: "toolCall", toolName: "request_patch_handoff", toolCallId: "hidden", input: {} },
            ]),
            assistant("reason-two", [{ type: "reasoning", text: "Second summary" }]),
        ]
        const live = assistant("live", [{ type: "reasoning", text: "Live summary" },
            { type: "toolCall", toolName: "read", toolCallId: "three", input: { path: "last.ts" } }])
        const setup = await testRender(<box flexDirection="column">
            <Transcript messages={messages} streamingMessage={live} />
            <text>Footer</text>
        </box>, { width, height: 20 })
        try {
            await act(async () => { await setup.renderOnce() })
            const rows = setup.captureCharFrame().split("\n").map(row => row.trim())
            const row = (text: string) => rows.findIndex(value => value.includes(text))
            expect(row("first.ts")).toBe(1)
            expect(row("second.ts")).toBe(row("first.ts") + 1)
            expect(row("First summary")).toBe(row("second.ts") + 2)
            expect(row("Second summary")).toBe(row("First summary") + 1)
            expect(row("Live summary")).toBe(row("Second summary") + 1)
            expect(row("last.ts")).toBe(row("Live summary") + 2)
            expect(row("Footer")).toBe(row("last.ts") + 2)
        } finally { act(() => setup.renderer.destroy()) }
    })
}
