import { expect, test } from "bun:test"

import { presentToolCall } from "@/ui/conversation/tools/tool-call-presentation"
import { theme } from "@/ui/terminal/theme"

test("prepares full Bash commands without React or terminal rendering", () => {
    const command = `echo ${"argument ".repeat(30)}\nprintf 'done'`
    const presentation = presentToolCall({
        call: { type: "toolCall", toolCallId: "call", toolName: "bash", input: { command, timeout: 120 } },
        phase: "running",
    })
    expect(presentation).toMatchObject({
        name: "Bash", target: command, detail: "timeout=120", accent: theme.amber,
    })
})

test.each([false, true])("keeps the complete Bash output separate from the compact summary (error=%s)", (isError) => {
    const content = `stdout:\n${"output line\n".repeat(30)}stderr:\nUNIQUE_OUTPUT_END`
    const presentation = presentToolCall({
        result: { id: "result", sessionId: "s", runId: "r", createdAt: 1,
            role: "toolResult", assistantMessageId: "assistant", toolCallId: "call",
            toolName: "bash", content, isError, summary: "Command finished" },
    })
    expect(presentation?.output).toBe(content)
    expect(presentation?.detail).toBe("Command finished")
})

test("does not create presentations for missing or hidden legacy tools", () => {
    expect(presentToolCall({})).toBeUndefined()
    expect(presentToolCall({
        call: { type: "toolCall", toolCallId: "call", toolName: "request_patch_handoff", input: {} },
    })).toBeUndefined()
})
