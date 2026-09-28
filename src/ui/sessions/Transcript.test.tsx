import { expect, test } from "bun:test"
import {
    BoxRenderable,
    CodeRenderable,
    DiffRenderable,
    LineNumberRenderable,
    MarkdownRenderable,
    RGBA,
    type Renderable,
    type ScrollBoxRenderable,
    TextAttributes,
    TextRenderable,
    TextTableRenderable,
} from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { act, useState } from "react"

import type { TAgentMessage, IAssistantMessage } from "@/agent"
import type { ICompactionCheckpoint, ICompactionProgress } from "@/sessions"
import { Transcript } from "@/ui/sessions"
import { syntax, theme } from "@/ui/terminal/theme"

function codeRenderables(root: Renderable): CodeRenderable[] {
    return root.getChildren().flatMap((child) => [
        ...(child instanceof CodeRenderable ? [child] : []),
        ...codeRenderables(child),
    ])
}

function diffRenderables(root: Renderable): DiffRenderable[] {
    return root.getChildren().flatMap((child) => [
        ...(child instanceof DiffRenderable ? [child] : []),
        ...diffRenderables(child),
    ])
}

function textRenderables(root: Renderable): TextRenderable[] {
    return root.getChildren().flatMap((child) => [
        ...(child instanceof TextRenderable ? [child] : []),
        ...textRenderables(child),
    ])
}

function markdownRenderables(root: Renderable): MarkdownRenderable[] {
    return root.getChildren().flatMap((child) => [
        ...(child instanceof MarkdownRenderable ? [child] : []),
        ...markdownRenderables(child),
    ])
}

function lineNumberRenderables(root: Renderable): LineNumberRenderable[] {
    return root.getChildren().flatMap((child) => [
        ...(child instanceof LineNumberRenderable ? [child] : []),
        ...lineNumberRenderables(child),
    ])
}

function tableRenderables(root: Renderable): TextTableRenderable[] {
    return root.getChildren().flatMap((child) => [
        ...(child instanceof TextTableRenderable ? [child] : []),
        ...tableRenderables(child),
    ])
}

test.each([40, 80])("renders untitled full-width user cards with literal content at %i columns", async (width) => {
    const content = [
        "",
        "  # Literal **prompt** `code`  ",
        "    indented zażółć 🐍 日本語",
        "\tTabbed line",
        "",
        "wrapped text ".repeat(12),
        "unbrokentoken".repeat(10),
        "  trailing spaces  ",
        "",
    ].join("\n")
    const setup = await testRender(<box flexDirection="column">
        <text id="history-header" height={1} flexShrink={0}>Before history</text>
        <Transcript messages={[{
            id: "literal-prompt",
            sessionId: "default",
            runId: "run",
            role: "user",
            source: "prompt",
            createdAt: 1,
            content,
        }]} />
        <text id="history-footer" height={1} flexShrink={0}>After history</text>
    </box>, { width, height: 30 })

    try {
        await act(async () => { await setup.renderOnce() })
        const card = setup.renderer.root.findDescendantById("user-message-literal-prompt") as BoxRenderable
        const body = card.getChildren()[0] as TextRenderable
        const footer = setup.renderer.root.findDescendantById("history-footer")!
        expect(card).toBeInstanceOf(BoxRenderable)
        expect(card.title).toBeUndefined()
        expect(card.width).toBe(width)
        expect(card.x).toBe(0)
        expect(card.y).toBe(2)
        expect(card.borderStyle).toBe("single")
        expect(card.borderColor.equals(RGBA.fromHex(theme.green))).toBe(true)
        expect(card.backgroundColor.equals(RGBA.fromHex(theme.green))).toBe(false)
        expect(body).toBeInstanceOf(TextRenderable)
        expect(body.plainText).toBe(content)
        expect(body.fg.equals(RGBA.fromHex(theme.text))).toBe(true)
        expect(body.wrapMode).toBe("word")
        expect(body.truncate).toBe(false)
        expect(body.x).toBe(card.x + 2)
        expect(body.y).toBe(card.y + 1)
        expect(body.width).toBe(width - 4)
        expect(card.height).toBe(body.height + 2)
        expect(footer.y).toBe(card.y + card.height + 1)
        expect(footer.y).toBeLessThan(30)
        expect(markdownRenderables(card)).toHaveLength(0)
        expect(codeRenderables(card)).toHaveLength(0)

        const lines = setup.captureCharFrame().split("\n")
        expect(lines[card.y]).toBe(`┌${"─".repeat(width - 2)}┐`)
        expect(lines[card.y + card.height - 1]).toBe(`└${"─".repeat(width - 2)}┘`)
        expect(lines[card.y - 1]!.trim()).toBe("")
        expect(lines[card.y + card.height]!.trim()).toBe("")
        expect(lines[body.y + 1]).toStartWith("│   # Literal **prompt** `code`  ")
        expect(lines[body.y + 2]).toStartWith("│     indented zażółć 🐍 日本語")
        expect(lines.slice(body.y, body.y + body.height).join("").replace(/[│\s]/g, ""))
            .toBe(content.replace(/\s/g, ""))
        const spans = setup.captureSpans().lines.slice(card.y, card.y + card.height)
            .flatMap((line) => line.spans)
        expect(spans.filter((span) => /[┌─┐└┘│]/.test(span.text))
            .every((span) => span.fg.equals(RGBA.fromHex(theme.green)))).toBe(true)
        expect(spans.some((span) => span.bg.equals(RGBA.fromHex(theme.green)))).toBe(false)
    } finally {
        act(() => setup.renderer.destroy())
    }
})

test("renders direct, streaming, and persisted legacy tool messages", async () => {
    // Durable history can contain tool names removed from the active catalog.
    const messages: TAgentMessage[] = [
        {
            id: "user-message",
            sessionId: "default",
            runId: "run-1",
            role: "user",
            source: "prompt",
            createdAt: 1,
            content: "  User prompt  ",
        },
        {
            id: "assistant-message",
            sessionId: "default",
            runId: "run-1",
            role: "assistant",
            createdAt: 2,
            stopReason: "tool-use",
            content: [
                {
                    type: "reasoning",
                    text: "Released reasoning summary",
                },
                {
                    type: "toolCall",
                    toolCallId: "call-grep",
                    toolName: "grep",
                    input: { pattern: "AgentSession" },
                },
                {
                    type: "toolCall",
                    toolCallId: "call-read",
                    toolName: "read_file",
                    input: { path: "missing.ts" },
                },
                {
                    type: "toolCall",
                    toolCallId: "call-patch-rejected",
                    toolName: "apply_patch",
                    input: {
                        explanation: "Test rejection",
                        changes: [{ kind: "delete", path: "rejected.txt" }],
                    },
                },
                {
                    type: "toolCall",
                    toolCallId: "call-command-manual",
                    toolName: "bash",
                    input: { command: "bun test" },
                },
                {
                    type: "toolCall",
                    toolCallId: "call-patch-committed",
                    toolName: "apply_patch",
                    input: {
                        explanation: "Test abort",
                        changes: [{ kind: "delete", path: "aborted.txt" }],
                    },
                },
                {
                    type: "toolCall",
                    toolCallId: "call-command-failed",
                    toolName: "bash",
                    input: { command: "exit 7" },
                },
                {
                    type: "toolCall",
                    toolCallId: "call-command-unknown",
                    toolName: "bash",
                    input: { command: "long-running-command" },
                },
                {
                    type: "text",
                    text: "Assistant answer",
                },
            ],
        },
        {
            id: "grep-result",
            sessionId: "default",
            runId: "run-1",
            role: "toolResult",
            createdAt: 3,
            toolCallId: "call-grep",
            toolName: "grep",
            content: "src/session/agent-session.ts:28",
            isError: false,
            outcome: "completed",
            summary: "Routine completion detail",
        },
        {
            id: "read-result",
            sessionId: "default",
            runId: "run-1",
            role: "toolResult",
            createdAt: 4,
            toolCallId: "call-read",
            toolName: "read_file",
            content: "File not found",
            isError: true,
        },
        {
            id: "rejected-result",
            sessionId: "default",
            runId: "run-1",
            role: "toolResult",
            createdAt: 5,
            toolCallId: "call-patch-rejected",
            toolName: "apply_patch",
            content: "No files changed",
            isError: false,
            outcome: "rejected",
            summary: "User rejected the workspace patch",
        },
        {
            id: "manual-result",
            sessionId: "default",
            runId: "run-1",
            role: "toolResult",
            createdAt: 6,
            toolCallId: "call-command-manual",
            toolName: "bash",
            content: "Command copied",
            isError: false,
            outcome: "manual",
            summary: "Run the copied command manually",
        },
        {
            id: "committed-result",
            sessionId: "default",
            runId: "run-1",
            role: "toolResult",
            createdAt: 7,
            toolCallId: "call-patch-committed",
            toolName: "apply_patch",
            content: "Patch commit completed",
            isError: true,
            outcome: "committed-after-abort",
            summary: "WARNING: Workspace changes were committed despite cancellation.",
        },
        {
            id: "failed-result",
            sessionId: "default",
            runId: "run-1",
            role: "toolResult",
            createdAt: 8,
            toolCallId: "call-command-failed",
            toolName: "bash",
            content: "exit code: 7",
            isError: true,
            outcome: "failed",
            summary: "Command exited with code 7",
        },
        {
            id: "unknown-result",
            sessionId: "default",
            runId: "run-1",
            role: "toolResult",
            createdAt: 9,
            toolCallId: "call-command-unknown",
            toolName: "bash",
            content: "Command was aborted after it started",
            isError: true,
            outcome: "effects-unknown",
            summary: "Inspect current state before retrying",
        },
        {
            id: "failed-assistant-message",
            sessionId: "default",
            runId: "run-2",
            role: "assistant",
            createdAt: 8,
            content: [],
            stopReason: "error",
            errorMessage: "TypeError: Invalid OpenAI authentication",
        },
    ]
    const streamingMessage: IAssistantMessage = {
        id: "streaming-assistant-message",
        sessionId: "default",
        runId: "run-3",
        role: "assistant",
        createdAt: 9,
        stopReason: "pending",
        content: [
            { type: "reasoning", text: "Streaming reasoning summary" },
            { type: "text", text: "Streaming answer" },
            {
                type: "toolCall",
                toolCallId: "call-find",
                toolName: "find",
                input: { pattern: "**/*.ts" },
            },
        ],
    }
    const setup = await testRender(<Transcript
        messages={messages}
        streamingMessage={streamingMessage}
        activeRunId="run-3"
    />, {
        width: 80,
        height: 30,
    })

    try {
        await act(async () => {
            await setup.renderOnce()
            await Promise.all(
                codeRenderables(setup.renderer.root).map((renderable) =>
                    renderable.highlightingDone
                ),
            )
            await setup.renderOnce()
        })
        const frame = setup.captureCharFrame()
        expect(frame).toContain("User prompt")
        expect(frame).toContain("Assistant answer")
        expect(frame).not.toContain("[call]")
        expect(frame).not.toContain("[done]")
        expect(frame).toContain("Grep [AgentSession]")
        expect(frame).toContain("read_file")
        expect(frame).toContain("File not found")
        expect(frame).toContain("User rejected the workspace patch")
        expect(frame).toContain("Run the copied command manually")
        expect(frame).toContain("Streaming answer")
        expect(frame).toContain("Find [**/*.ts]")
        expect(frame).toContain("TypeError: Invalid OpenAI authentication")
        expect(frame).toContain("Thought: Released reasoning summary")
        expect(frame).toContain("Thinking: Streaming reasoning summary")
        expect(frame).not.toContain("src/session/agent-session.ts:28")
        const completedLine = textRenderables(setup.renderer.root).find((renderable) =>
            renderable.plainText.startsWith("Grep [AgentSession]")
        )
        expect(completedLine?.plainText).toContain("Routine completion detail")
        const committedLine = textRenderables(setup.renderer.root).find((renderable) =>
            renderable.plainText.includes("Workspace changes were committed")
        )
        expect(committedLine?.plainText).toContain(
            "Workspace changes were committed despite cancellation",
        )
        expect(committedLine?.plainText).toContain("Patch commit completed")
        expect(committedLine?.fg.equals(RGBA.fromHex(theme.red))).toBe(true)
        const failedLine = textRenderables(setup.renderer.root).find((renderable) =>
            renderable.plainText.includes("Command exited with code 7")
        )
        expect(failedLine?.plainText).toContain("Command exited with code 7")
        expect(failedLine?.fg.equals(RGBA.fromHex(theme.red))).toBe(true)
        const unknownLine = textRenderables(setup.renderer.root).find((renderable) =>
            renderable.plainText.includes("Inspect current state before retrying")
        )
        expect(unknownLine?.plainText).toContain("Inspect current state before retrying")
        expect(unknownLine?.fg.equals(RGBA.fromHex(theme.red))).toBe(true)
    } finally {
        act(() => {
            setup.renderer.destroy()
        })
    }
})

test("renders technical tool parameters without text statuses", async () => {
    const message: IAssistantMessage = {
        id: "active-tools",
        sessionId: "default",
        runId: "run-active",
        role: "assistant",
        createdAt: 1,
        stopReason: "tool-use",
        content: [
            {
                type: "toolCall",
                toolCallId: "call-bash",
                toolName: "bash",
                input: {
                    command: "bun test",
                    timeout: 30,
                },
            },
            {
                type: "toolCall",
                toolCallId: "call-read",
                toolName: "read",
                input: { path: "src/app.ts", offset: 20, limit: 40 },
            },
            {
                type: "toolCall",
                toolCallId: "call-find",
                toolName: "find",
                input: { pattern: "**/*.ts", path: "src", limit: 25 },
            },
            {
                type: "toolCall",
                toolCallId: "call-grep",
                toolName: "grep",
                input: {
                    pattern: "AgentSession",
                    path: "src",
                    glob: "*.ts",
                    ignoreCase: true,
                    literal: true,
                    context: 2,
                    limit: 25,
                },
            },
            {
                type: "toolCall",
                toolCallId: "call-edit",
                toolName: "edit",
                input: {
                    path: "src/app.ts",
                    edits: [{ oldText: "before", newText: "after" }],
                },
            },
            {
                type: "toolCall",
                toolCallId: "call-write",
                toolName: "write",
                input: { path: "src/new.ts", content: "export {}\n" },
            },
        ],
    }
    const setup = await testRender(<Transcript
        messages={[message]}
        activeRunId="run-active"
        pendingToolCallIds={["call-bash"]}
    />, {
        width: 100,
        height: 10,
    })

    try {
        await act(async () => {
            await setup.renderOnce()
        })

        const lines = textRenderables(setup.renderer.root)
        expect(lines.map((line) => line.plainText)).toEqual([
            "Bash [bun test] timeout=30",
            "Read [src/app.ts] offset=20 limit=40",
            "Find [**/*.ts] path=src limit=25",
            "Grep [AgentSession] path=src glob=*.ts ignoreCase=true literal=true context=2 limit=25",
            'Edit [src/app.ts]',
            "Write [src/new.ts]",
        ])
        expect(lines.every((line) => line.fg.equals(RGBA.fromHex(theme.amber)))).toBe(true)
    } finally {
        act(() => {
            setup.renderer.destroy()
        })
    }
})

test("updates one tool activity line from active to completed", async () => {
    let completeTool: (() => void) | undefined

    function EvolvingToolTranscript(): React.ReactNode {
        const [completed, setCompleted] = useState(false)
        completeTool = () => setCompleted(true)
        const messages: TAgentMessage[] = [
            {
                id: "assistant-tool",
                sessionId: "default",
                runId: "run-tool",
                role: "assistant",
                createdAt: 1,
                stopReason: "tool-use",
                content: [{
                    type: "toolCall",
                    toolCallId: "call-read",
                    toolName: "read",
                    input: { path: "src/app.ts" },
                }],
            },
            ...(completed ? [{
                id: "read-result",
                sessionId: "default",
                runId: "run-tool",
                role: "toolResult" as const,
                createdAt: 2,
                toolCallId: "call-read",
                toolName: "read",
                content: "1: content",
                isError: false,
                outcome: "completed" as const,
                summary: "line 1",
            }] : []),
        ]
        return <Transcript
            messages={messages}
            {...(completed ? {} : { activeRunId: "run-tool" })}
            pendingToolCallIds={completed ? [] : ["call-read"]}
        />
    }

    const setup = await testRender(<EvolvingToolTranscript />, {
        width: 80,
        height: 5,
    })

    try {
        await act(async () => {
            await setup.renderOnce()
        })
        const lineBefore = textRenderables(setup.renderer.root)[0]
        expect(lineBefore?.plainText).toBe("Read [src/app.ts]")

        act(() => {
            completeTool?.()
        })
        await act(async () => {
            await setup.renderOnce()
        })

        const linesAfter = textRenderables(setup.renderer.root)
        expect(linesAfter).toHaveLength(1)
        expect(linesAfter[0]).toBe(lineBefore)
        expect(linesAfter[0]?.plainText).toBe("Read [src/app.ts] line 1 ✓")
    } finally {
        act(() => {
            setup.renderer.destroy()
        })
    }
})

test("keeps one tool activity line across the streaming message boundary", async () => {
    let persistAssistant: (() => void) | undefined

    function StreamingToolTranscript(): React.ReactNode {
        const [persisted, setPersisted] = useState(false)
        persistAssistant = () => setPersisted(true)
        const assistant: IAssistantMessage = {
            id: "streaming-tool",
            sessionId: "default",
            runId: "run-streaming-tool",
            role: "assistant",
            createdAt: 1,
            stopReason: persisted ? "tool-use" : "pending",
            content: [{
                type: "toolCall",
                toolCallId: "call-find",
                toolName: "find",
                input: { pattern: "**/*.tsx" },
            }],
        }
        return <Transcript
            messages={persisted ? [assistant] : []}
            {...(persisted ? {} : { streamingMessage: assistant })}
            activeRunId="run-streaming-tool"
        />
    }

    const setup = await testRender(<StreamingToolTranscript />, {
        width: 80,
        height: 5,
    })

    try {
        await act(async () => {
            await setup.renderOnce()
        })
        const lineBefore = textRenderables(setup.renderer.root)[0]
        expect(lineBefore?.plainText).toBe("Find [**/*.tsx]")

        act(() => {
            persistAssistant?.()
        })
        await act(async () => {
            await setup.renderOnce()
        })

        const linesAfter = textRenderables(setup.renderer.root)
        expect(linesAfter).toHaveLength(1)
        expect(linesAfter[0]).toBe(lineBefore)
        expect(linesAfter[0]?.plainText).toBe("Find [**/*.tsx]")
    } finally {
        act(() => {
            setup.renderer.destroy()
        })
    }
})

test("truncates tool targets without splitting Unicode code points", async () => {
    const path = `${"a".repeat(92)}😀tail`
    const message: IAssistantMessage = {
        id: "unicode-tool",
        sessionId: "default",
        runId: "run-unicode",
        role: "assistant",
        createdAt: 1,
        stopReason: "tool-use",
        content: [{
            type: "toolCall",
            toolCallId: "call-read",
            toolName: "read",
            input: { path },
        }],
    }
    const setup = await testRender(<Transcript
        messages={[message]}
        activeRunId="run-unicode"
    />, {
        width: 80,
        height: 5,
    })

    try {
        await act(async () => {
            await setup.renderOnce()
        })

        const line = textRenderables(setup.renderer.root)[0]?.plainText
        expect(line).toContain("😀...")
        expect(line).not.toContain("�")
    } finally {
        act(() => {
            setup.renderer.destroy()
        })
    }
})

test("pairs out-of-order results and preserves orphan results", async () => {
    const assistant: IAssistantMessage = {
        id: "tool-batch",
        sessionId: "default",
        runId: "run-tools",
        role: "assistant",
        createdAt: 1,
        stopReason: "tool-use",
        content: [
            {
                type: "toolCall",
                toolCallId: "call-grep",
                toolName: "grep",
                input: { pattern: "needle" },
            },
            {
                type: "toolCall",
                toolCallId: "call-bash",
                toolName: "bash",
                input: { command: "bun test" },
            },
        ],
    }
    const messages: TAgentMessage[] = [
        assistant,
        {
            id: "bash-result",
            sessionId: "default",
            runId: "run-tools",
            role: "toolResult",
            createdAt: 2,
            toolCallId: "call-bash",
            toolName: "bash",
            content: "Command may have changed files",
            isError: true,
            outcome: "effects-unknown",
            summary: "Inspect state before retrying",
        },
        {
            id: "orphan-result",
            sessionId: "default",
            runId: "run-tools",
            role: "toolResult",
            createdAt: 3,
            toolCallId: "orphan",
            toolName: "read",
            content: "Orphan result detail",
            isError: true,
        },
        {
            id: "grep-result",
            sessionId: "default",
            runId: "run-tools",
            role: "toolResult",
            createdAt: 4,
            toolCallId: "call-grep",
            toolName: "grep",
            content: "src/example.ts:1:needle",
            isError: false,
            outcome: "completed",
            summary: "1 match",
        },
    ]
    const setup = await testRender(<Transcript messages={messages} />, {
        width: 100,
        height: 10,
    })

    try {
        await act(async () => {
            await setup.renderOnce()
        })

        const lines = textRenderables(setup.renderer.root)
        expect(lines.map((line) => line.plainText)).toEqual([
            "Grep [needle] 1 match ✓",
            "Bash [bun test] Inspect state before retrying | Command may have changed files ×",
            "Read Orphan result detail ×",
        ])
        expect(lines[1]?.fg.equals(RGBA.fromHex(theme.red))).toBe(true)
        expect(lines[2]?.fg.equals(RGBA.fromHex(theme.red))).toBe(true)
    } finally {
        act(() => {
            setup.renderer.destroy()
        })
    }
})

test("does not pair results to calls from a failed assistant turn", async () => {
    const messages: TAgentMessage[] = [
        {
            id: "failed-tool-turn",
            sessionId: "default",
            runId: "run-failed-turn",
            role: "assistant",
            createdAt: 1,
            stopReason: "error",
            content: [{
                type: "toolCall",
                toolCallId: "call-read",
                toolName: "read",
                input: { path: "never-read.ts" },
            }],
        },
        {
            id: "invalid-result",
            sessionId: "default",
            runId: "run-failed-turn",
            role: "toolResult",
            createdAt: 2,
            toolCallId: "call-read",
            toolName: "read",
            content: "Unexpected legacy result",
            isError: true,
        },
    ]
    const setup = await testRender(<Transcript messages={messages} />, {
        width: 80,
        height: 6,
    })

    try {
        await act(async () => {
            await setup.renderOnce()
        })

        expect(textRenderables(setup.renderer.root).map((line) => line.plainText)).toEqual([
            "Read [never-read.ts] ×",
            "Read Unexpected legacy result ×",
        ])
    } finally {
        act(() => {
            setup.renderer.destroy()
        })
    }
})

test("scopes an active reused tool call id to its current run", async () => {
    const messages: TAgentMessage[] = [
        {
            id: "old-assistant",
            sessionId: "default",
            runId: "run-old",
            role: "assistant",
            createdAt: 1,
            stopReason: "tool-use",
            content: [{
                type: "toolCall",
                toolCallId: "shared-call",
                toolName: "read",
                input: { path: "old.ts" },
            }],
        },
        {
            id: "old-result",
            sessionId: "default",
            runId: "run-old",
            role: "toolResult",
            createdAt: 2,
            toolCallId: "shared-call",
            toolName: "read",
            content: "old content",
            isError: false,
            outcome: "completed",
            summary: "read old file",
        },
        {
            id: "current-assistant",
            sessionId: "default",
            runId: "run-current",
            role: "assistant",
            createdAt: 3,
            stopReason: "tool-use",
            content: [{
                type: "toolCall",
                toolCallId: "shared-call",
                toolName: "read",
                input: { path: "current.ts" },
            }],
        },
    ]
    const setup = await testRender(<Transcript
        messages={messages}
        activeRunId="run-current"
        pendingToolCallIds={["shared-call"]}
    />, {
        width: 80,
        height: 8,
    })

    try {
        await act(async () => {
            await setup.renderOnce()
        })

        expect(textRenderables(setup.renderer.root).map((line) => line.plainText)).toEqual([
            "Read [old.ts] read old file ✓",
            "Read [current.ts]",
        ])
    } finally {
        act(() => {
            setup.renderer.destroy()
        })
    }
})

test("renders full reasoning summaries as plain text in content order", async () => {
    const summary = [
        "First summary line",
        "**literal Markdown syntax**",
        "Final summary line remains available without truncation.",
    ].join("\n")
    const completedMessage: IAssistantMessage = {
        id: "completed-reasoning",
        sessionId: "default",
        runId: "run-completed-reasoning",
        role: "assistant",
        createdAt: 1,
        stopReason: "stop",
        content: [
            { type: "text", text: "Before summary" },
            { type: "reasoning", text: summary },
            { type: "text", text: "After summary" },
        ],
    }
    const streamingMessage: IAssistantMessage = {
        id: "streaming-reasoning",
        sessionId: "default",
        runId: "run-streaming-reasoning",
        role: "assistant",
        createdAt: 2,
        stopReason: "pending",
        content: [{ type: "reasoning", text: "Live released summary" }],
    }
    const setup = await testRender(<Transcript
        messages={[completedMessage]}
        streamingMessage={streamingMessage}
    />, {
        width: 80,
        height: 20,
    })

    try {
        await act(async () => {
            await setup.renderOnce()
            await Promise.all(
                codeRenderables(setup.renderer.root).map((renderable) =>
                    renderable.highlightingDone
                ),
            )
            await setup.renderOnce()
        })

        const texts = textRenderables(setup.renderer.root)
        const completedReasoning = texts.find((renderable) =>
            renderable.plainText === `Thought: ${summary}`
        )
        const streamingReasoning = texts.find((renderable) =>
            renderable.plainText === "Thinking: Live released summary"
        )
        expect(completedReasoning).toBeDefined()
        expect(completedReasoning?.fg.equals(RGBA.fromHex(theme.textMuted))).toBe(true)
        expect(completedReasoning?.wrapMode).toBe("word")
        expect(completedReasoning?.truncate).toBe(false)
        expect(streamingReasoning).toBeDefined()
        expect(streamingReasoning?.fg.equals(RGBA.fromHex(theme.textMuted))).toBe(true)
        expect(streamingReasoning?.wrapMode).toBe("word")
        expect(streamingReasoning?.truncate).toBe(false)
        expect(markdownRenderables(setup.renderer.root)).toHaveLength(2)

        const frame = setup.captureCharFrame()
        expect(frame).toContain("**literal Markdown syntax**")
        expect(frame.indexOf("Before summary")).toBeLessThan(frame.indexOf("Thought:"))
        expect(frame.indexOf("Thought:")).toBeLessThan(frame.indexOf("After summary"))
        expect(completedReasoning!.parent!.height).toBe(completedReasoning!.height + 1)
        expect(streamingReasoning!.parent!.height).toBe(streamingReasoning!.height + 1)
        const afterSummary = markdownRenderables(setup.renderer.root)[1]!
        expect(afterSummary.y).toBe(completedReasoning!.y + completedReasoning!.height + 1)
        expect(frame.split("\n")[afterSummary.y - 1]!.trim()).toBe("")
        const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
        for (const [text, color] of [
            ["Thought:", theme.pink],
            ["Thinking:", theme.amber],
            ["Live released summary", theme.textMuted],
            ["**literal Markdown syntax**", theme.textMuted],
        ]) {
            expect(spans.find((span) => span.text.includes(text!))?.fg.equals(
                RGBA.fromHex(color!),
            )).toBe(true)
        }
    } finally {
        act(() => {
            setup.renderer.destroy()
        })
    }
})

test("shows work for empty streaming reasoning and hides empty completed reasoning", async () => {
    const completedMessage: IAssistantMessage = {
        id: "empty-completed-reasoning",
        sessionId: "default",
        runId: "run-empty-completed-reasoning",
        role: "assistant",
        createdAt: 1,
        stopReason: "stop",
        content: [{ type: "reasoning", text: "" }],
    }
    const streamingMessage: IAssistantMessage = {
        id: "empty-streaming-reasoning",
        sessionId: "default",
        runId: "run-empty-streaming-reasoning",
        role: "assistant",
        createdAt: 2,
        stopReason: "pending",
        content: [{ type: "reasoning", text: "" }],
    }
    const setup = await testRender(<Transcript
        messages={[completedMessage]}
        streamingMessage={streamingMessage}
    />, {
        width: 80,
        height: 10,
    })

    try {
        await act(async () => {
            await setup.renderOnce()
        })

        const reasoning = textRenderables(setup.renderer.root).filter((renderable) =>
            renderable.plainText.startsWith("Thinking")
        )
        expect(reasoning).toHaveLength(1)
        expect(reasoning[0]?.plainText).toBe("Thinking...")
        const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
        expect(spans.find((span) => span.text.includes("Thinking..."))?.fg.equals(
            RGBA.fromHex(theme.amber),
        )).toBe(true)
        expect(reasoning[0]!.parent!.height).toBe(reasoning[0]!.height + 1)
        expect(setup.captureCharFrame()).not.toContain("Thought")
    } finally {
        act(() => {
            setup.renderer.destroy()
        })
    }
})

test("keeps completed headings stable while streaming markdown grows", async () => {
    let updateText: ((text: string) => void) | undefined

    function StreamingTranscript(): React.ReactNode {
        const [text, setText] = useState("# Stable heading\n\nPartial paragraph")
        updateText = setText
        const streamingMessage: IAssistantMessage = {
            id: "streaming-markdown",
            sessionId: "default",
            runId: "run-streaming-markdown",
            role: "assistant",
            createdAt: 1,
            stopReason: "pending",
            content: [{ type: "text", text }],
        }
        return <Transcript messages={[]} streamingMessage={streamingMessage} />
    }

    const setup = await testRender(<StreamingTranscript />, {
        width: 80,
        height: 12,
    })

    try {
        await act(async () => {
            await setup.renderOnce()
        })
        const markdownBefore = markdownRenderables(setup.renderer.root)[0]
        expect(markdownBefore).toBeDefined()
        expect(markdownBefore?.streaming).toBe(true)
        expect(markdownBefore?.internalBlockMode).toBe("top-level")
        expect(markdownBefore?.renderNode).toBeFunction()
        expect(markdownBefore?.tableOptions).toEqual({
            style: "grid",
            widthMode: "full",
            columnFitter: "proportional",
            wrapMode: "word",
            cellPaddingX: 1,
            cellPaddingY: 0,
            borders: true,
            outerBorder: true,
            borderStyle: "single",
            borderColor: theme.textMuted,
            selectable: true,
        })
        const headingBefore = markdownBefore?._blockStates[0]?.renderable
        expect(headingBefore).toBeDefined()
        expect(setup.captureCharFrame()).toContain("Partial paragraph")

        act(() => {
            updateText?.("# Stable heading\n\nPartial paragraph continues")
        })
        await act(async () => {
            await setup.renderOnce()
        })

        const markdownAfter = markdownRenderables(setup.renderer.root)[0]
        expect(markdownAfter).toBe(markdownBefore)
        expect(markdownAfter?._blockStates[0]?.renderable).toBe(headingBefore)
        expect(markdownAfter?.content).toBe("# Stable heading\n\nPartial paragraph continues")
        expect(setup.captureCharFrame()).toContain("Partial paragraph continues")
    } finally {
        act(() => {
            setup.renderer.destroy()
        })
    }
})

test("updates streaming code without replacing its renderable", async () => {
    let updateText: ((text: string) => void) | undefined

    function StreamingCodeTranscript(): React.ReactNode {
        const [text, setText] = useState("```typescript\nconst one = 1")
        updateText = setText
        return <Transcript
            messages={[]}
            streamingMessage={{
                id: "streaming-code",
                sessionId: "default",
                runId: "run-streaming-code",
                role: "assistant",
                createdAt: 1,
                stopReason: "pending",
                content: [{ type: "text", text }],
            }}
        />
    }

    const setup = await testRender(<StreamingCodeTranscript />, {
        width: 80,
        height: 8,
    })

    try {
        await act(async () => {
            await setup.renderOnce()
        })
        const codeBefore = codeRenderables(setup.renderer.root).find(
            (renderable) => renderable.filetype === "typescript",
        )
        expect(codeBefore).toBeDefined()
        expect(lineNumberRenderables(setup.renderer.root)).toHaveLength(0)

        act(() => {
            updateText?.("```typescript\nconst one = 1\nconst two = 2\n```")
        })
        await act(async () => {
            await setup.renderOnce()
        })

        const codeAfter = codeRenderables(setup.renderer.root).find(
            (renderable) => renderable.filetype === "typescript",
        )
        expect(codeAfter).toBe(codeBefore)
        expect(codeAfter?.content).toBe("const one = 1\nconst two = 2")
        await act(async () => {
            await codeAfter?.highlightingDone
            await setup.renderOnce()
        })
        expect(setup.captureCharFrame()).toContain("const two = 2")
    } finally {
        act(() => {
            setup.renderer.destroy()
        })
    }
})

test("replaces a completed streaming diff block with the diff viewer", async () => {
    let finishDiff: (() => void) | undefined
    const patch = [
        "--- a/example.ts",
        "+++ b/example.ts",
        "@@ -1 +1 @@",
        "-const answer = 1",
        "+const answer = 2",
    ].join("\n")

    function StreamingDiffTranscript(): React.ReactNode {
        const [closed, setClosed] = useState(false)
        finishDiff = () => setClosed(true)
        const text = `\`\`\`diff\n${patch}${closed ? "\n```" : ""}`

        return <Transcript
            messages={[]}
            streamingMessage={{
                id: "streaming-diff",
                sessionId: "default",
                runId: "run-streaming-diff",
                role: "assistant",
                createdAt: 1,
                stopReason: "pending",
                content: [{ type: "text", text }],
            }}
        />
    }

    const setup = await testRender(<StreamingDiffTranscript />, {
        width: 80,
        height: 12,
    })

    try {
        await act(async () => {
            await setup.renderOnce()
        })

        expect(diffRenderables(setup.renderer.root)).toHaveLength(0)
        expect(codeRenderables(setup.renderer.root).some(
            (renderable) => renderable.filetype === "diff",
        )).toBe(false)
        const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
        expect(spans.find((span) => span.text.includes("-const answer = 1"))?.fg.equals(RGBA.fromHex(theme.red))).toBe(true)
        expect(spans.find((span) => span.text.includes("+const answer = 2"))?.fg.equals(RGBA.fromHex(theme.green))).toBe(true)

        act(() => {
            finishDiff?.()
        })
        await act(async () => {
            await setup.renderOnce()
        })

        const diffs = diffRenderables(setup.renderer.root)
        expect(diffs).toHaveLength(1)
        expect(diffs[0]?.diff).toBe(patch)
    } finally {
        act(() => {
            setup.renderer.destroy()
        })
    }
})

test("repairs completed diff counts before creating the diff viewer", async () => {
    const patch = [
        "--- a/example.ts",
        "+++ b/example.ts",
        "@@ -1,2 +1,3 @@",
        " const answer = 1",
        "+const repaired = true",
    ].join("\n")
    const message: IAssistantMessage = {
        id: "repaired-diff",
        sessionId: "default",
        runId: "run-repaired-diff",
        role: "assistant",
        createdAt: 1,
        stopReason: "stop",
        content: [{ type: "text", text: `\`\`\`diff\n${patch}\n\`\`\`` }],
    }
    const setup = await testRender(<Transcript messages={[message]} />, {
        width: 80,
        height: 12,
    })

    try {
        await act(async () => {
            await setup.renderOnce()
        })

        const diffs = diffRenderables(setup.renderer.root)
        expect(diffs).toHaveLength(1)
        expect(diffs[0]?.diff).toContain("@@ -1,1 +1,2 @@")
        expect(message.content[0]).toEqual({
            type: "text",
            text: `\`\`\`diff\n${patch}\n\`\`\``,
        })
        expect(setup.captureCharFrame()).not.toContain("Error parsing diff")
    } finally {
        act(() => {
            setup.renderer.destroy()
        })
    }
})

test.each(["proposal", "markdown"] as const)(
    "clips %s diff backgrounds and numbered text when scrolling the transcript",
    async (kind) => {
        const patch = [
            "--- a/example.txt",
            "+++ b/example.txt",
            "@@ -1232,27 +1232,27 @@",
            " context before 1232",
            "-removed 1233 with enough words to wrap on a narrow screen",
            "+added 1233 with enough words to wrap on a narrow screen",
            " context after 1234",
            ...Array.from({ length: 24 }, (_, i) => ` context tail ${1235 + i}`),
        ].join("\n")
        const messages: TAgentMessage[] = [{
            id: "diff-message",
            sessionId: "default",
            runId: "run-diff",
            role: "assistant",
            createdAt: 1,
            stopReason: "stop",
            content: kind === "markdown"
                ? [{ type: "text", text: `\`\`\`diff\n${patch}\n\`\`\`` }]
                : [],
        }, {
            id: "later-message",
            sessionId: "default",
            runId: "run-diff",
            role: "assistant",
            createdAt: 3,
            stopReason: "stop",
            content: [{
                type: "text",
                text: Array.from({ length: 20 }, (_, i) => `Later assistant row ${i}`)
                    .join("\n\n"),
            }],
        }]
        let scrollbox!: ScrollBoxRenderable
        const setup = await testRender(<scrollbox
            ref={(renderable) => { if (renderable) scrollbox = renderable }}
            width="100%"
            height="100%"
            scrollX={false}
            scrollY
        >
            <Transcript
                messages={messages}
                fileChangeProposals={kind === "proposal" ? [{
                    id: "scrolling-proposal",
                    sessionId: "default",
                    runId: "run-diff",
                    toolCallId: "edit-diff",
                    operation: "edit",
                    path: "example.txt",
                    diff: patch,
                    status: "applied",
                    createdAt: 2,
                }] : []}
            />
        </scrollbox>, { width: 80, height: 10 })

        const render = async () => {
            await act(async () => {
                await setup.renderOnce()
                await Promise.all(codeRenderables(setup.renderer.root).map(
                    (renderable) => renderable.highlightingDone,
                ))
                await setup.renderOnce()
            })
        }

        try {
            await render()
            const diffs = diffRenderables(setup.renderer.root)
            expect(diffs).toHaveLength(1)
            const diff = diffs[0]!
            expect(scrollbox.viewport.y).toBe(0)
            expect(diff.height).toBeGreaterThan(scrollbox.viewport.height)
            const initialFrame = setup.captureCharFrame()
            const initialSpans = setup.captureSpans()
            expect(initialFrame).toMatch(/1233.*-.*removed 1233/)
            expect(initialFrame).toMatch(/1233.*\+.*added 1233/)
            for (const [text, bg] of [
                ["removed 1233", diff.removedBg],
                ["added 1233", diff.addedBg],
            ] as const) {
                expect(initialSpans.lines.flatMap((line) => line.spans).some(
                    (span) => span.text.includes(text) && span.bg.equals(bg),
                )).toBe(true)
            }
            const contextRow = initialFrame.split("\n").findIndex(
                (line) => line.includes("context after 1234"),
            )
            expect(contextRow).toBeGreaterThan(0)
            const contextBg = initialSpans.lines[contextRow]!.spans.find(
                (span) => span.text.includes("context after 1234"),
            )!.bg
            expect(contextBg.a).toBe(0)

            act(() => scrollbox.scrollTo(contextRow))
            await render()
            expect(diff.y).toBeLessThan(0)
            expect(diff.y + diff.height).toBeGreaterThan(0)
            expect(setup.captureCharFrame().split("\n")[0]).toContain("context after 1234")
            const partialSpans = setup.captureSpans()

            act(() => scrollbox.scrollTo(scrollbox.scrollHeight))
            await render()
            expect(diff.y + diff.height).toBeLessThanOrEqual(0)
            const offscreenFrame = setup.captureCharFrame()
            expect(offscreenFrame).toContain("Later assistant row 19")
            expect(offscreenFrame).not.toMatch(/12\d{2}|removed|added|context/)
            const offscreenSpans = setup.captureSpans()
            await render()
            expect(setup.captureCharFrame()).toBe(offscreenFrame)
            const repaintedSpans = setup.captureSpans()

            act(() => scrollbox.scrollTo(0))
            await render()
            expect(setup.captureCharFrame()).toBe(initialFrame)
            expect(setup.captureSpans()).toEqual(initialSpans)

            const wideHeight = diff.height
            act(() => setup.resize(36, 10))
            await render()
            expect(diff.height).toBeGreaterThan(wideHeight)
            const narrowFrame = setup.captureCharFrame()
            expect(narrowFrame).toMatch(/1233.*-.*removed 1233/)
            expect(narrowFrame).toMatch(/1233.*\+.*added 1233/)
            expect(narrowFrame).toContain("narrow screen")
            for (const bg of [diff.removedBg, diff.addedBg]) {
                expect(setup.captureSpans().lines.flatMap((line) => line.spans).some(
                    (span) => span.text.includes("screen") && span.bg.equals(bg),
                )).toBe(true)
            }
            const continuationRow = narrowFrame.split("\n").findIndex(
                (line) => line.includes("narrow screen"),
            )
            expect(continuationRow).toBeGreaterThan(0)
            act(() => scrollbox.scrollTo(continuationRow))
            await render()
            expect(diff.y).toBeLessThan(0)
            expect(setup.captureSpans().lines[0]!.spans.some(
                (span) => span.text.includes("narrow screen") && span.bg.equals(diff.addedBg),
            )).toBe(true)

            act(() => {
                scrollbox.scrollTo(0)
                setup.resize(80, 10)
            })
            await render()
            expect(setup.captureCharFrame()).toBe(initialFrame)
            expect(setup.captureSpans()).toEqual(initialSpans)

            // Negative-Y fills must not repaint screen row zero, even on subsequent frames.
            expect({
                contextBackgroundPreserved: partialSpans.lines[0]!.spans.find(
                    (span) => span.text.includes("context after 1234"),
                )?.bg.equals(contextBg),
                offscreenDiffBackgrounds: [offscreenSpans, repaintedSpans].map(
                    (frame) => frame.lines.flatMap((line) => line.spans).some(
                        (span) => span.bg.equals(diff.addedBg) || span.bg.equals(diff.removedBg),
                    ),
                ),
            }).toEqual({
                contextBackgroundPreserved: true,
                offscreenDiffBackgrounds: [false, false],
            })
        } finally {
            act(() => setup.renderer.destroy())
        }
    },
)

test("colors text for a structurally malformed completed diff", async () => {
    const patch = [
        "--- a/example.ts",
        "+++ b/example.ts",
        "@@ -1 +1 @@",
        "line without a diff prefix",
    ].join("\n")
    const setup = await testRender(<Transcript messages={[{
        id: "malformed-diff",
        sessionId: "default",
        runId: "run-malformed-diff",
        role: "assistant",
        createdAt: 1,
        stopReason: "stop",
        content: [{ type: "text", text: `\`\`\`diff\n${patch}\n\`\`\`` }],
    }]} />, {
        width: 80,
        height: 12,
    })

    try {
        await act(async () => {
            await setup.renderOnce()
        })

        expect(diffRenderables(setup.renderer.root)).toHaveLength(0)
        expect(codeRenderables(setup.renderer.root).some(
            (renderable) => renderable.filetype === "diff",
        )).toBe(false)
        const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
        expect(spans.find((span) => span.text.includes("@@ -1 +1 @@"))?.fg.equals(RGBA.fromHex(theme.amber))).toBe(true)
        expect(setup.captureCharFrame()).toContain("line without a diff prefix")
        expect(setup.captureCharFrame()).not.toContain("Error parsing diff")
    } finally {
        act(() => {
            setup.renderer.destroy()
        })
    }
})

test("keeps completed history renderables stable across streaming text updates", async () => {
    let updateText: ((text: string) => void) | undefined
    const messages: TAgentMessage[] = [
        {
            id: "durable-user",
            sessionId: "default",
            runId: "run-durable",
            role: "user",
            source: "prompt",
            createdAt: 0,
            content: "  Preserve this prompt  ",
        },
        {
            id: "durable-assistant",
            sessionId: "default",
            runId: "run-durable",
            role: "assistant",
            createdAt: 1,
            stopReason: "tool-use",
            content: [
                {
                    type: "text",
                    text: "# Durable answer\n\n```ts\nconst stable = 1\nconst history = 2\n```",
                },
                {
                    type: "toolCall",
                    toolCallId: "durable-read",
                    toolName: "read",
                    input: { path: "src/stable.ts" },
                },
            ],
        },
        {
            id: "durable-result",
            sessionId: "default",
            runId: "run-durable",
            role: "toolResult",
            createdAt: 2,
            toolCallId: "durable-read",
            toolName: "read",
            content: "stable content",
            isError: false,
            outcome: "completed",
            summary: "cached presentation",
        },
    ]

    function StreamingWithHistory(): React.ReactNode {
        const [text, setText] = useState("Live start")
        updateText = setText
        return <Transcript
            messages={messages}
            streamingMessage={{
                id: "live-assistant",
                sessionId: "default",
                runId: "run-live",
                role: "assistant",
                createdAt: 3,
                stopReason: "pending",
                content: [{ type: "text", text }],
            }}
        />
    }

    const setup = await testRender(<StreamingWithHistory />, {
        width: 80,
        height: 18,
    })

    try {
        await act(async () => {
            await setup.renderOnce()
        })
        const userBefore = setup.renderer.root.findDescendantById("user-message-durable-user")!
        const userTextBefore = userBefore.getChildren()[0]
        const markdownBefore = markdownRenderables(setup.renderer.root)
        const historyCodeBefore = codeRenderables(markdownBefore[0]!).find(
            (renderable) => renderable.filetype === "typescript",
        )
        const toolBefore = textRenderables(setup.renderer.root).find((renderable) =>
            renderable.plainText.startsWith("Read [src/stable.ts]")
        )
        expect(markdownBefore).toHaveLength(2)
        expect(historyCodeBefore).toBeDefined()
        expect(toolBefore).toBeDefined()

        act(() => {
            updateText?.("Live text continues")
        })
        await act(async () => {
            await setup.renderOnce()
        })

        const markdownAfter = markdownRenderables(setup.renderer.root)
        const historyCodeAfter = codeRenderables(markdownAfter[0]!).find(
            (renderable) => renderable.filetype === "typescript",
        )
        const toolAfter = textRenderables(setup.renderer.root).find((renderable) =>
            renderable.plainText.startsWith("Read [src/stable.ts]")
        )
        const userAfter = setup.renderer.root.findDescendantById("user-message-durable-user")!
        expect(userAfter).toBe(userBefore)
        expect(userAfter.getChildren()[0]).toBe(userTextBefore)
        expect(markdownAfter[0]).toBe(markdownBefore[0])
        expect(markdownAfter[1]).toBe(markdownBefore[1])
        expect(historyCodeAfter).toBe(historyCodeBefore)
        expect(toolAfter).toBe(toolBefore)
        expect(setup.captureCharFrame()).toContain("Live text continues")
    } finally {
        act(() => {
            setup.renderer.destroy()
        })
    }
})

test("renders a checkpoint at its anchor before uncompacted and streaming messages", async () => {
    const messages: TAgentMessage[] = [
        {
            id: "compacted-user",
            sessionId: "default",
            runId: "run-old",
            role: "user",
            source: "prompt",
            createdAt: 1,
            content: "Compacted prefix",
        },
        {
            id: "uncompacted-user",
            sessionId: "default",
            runId: "run-new",
            role: "user",
            source: "prompt",
            createdAt: 2,
            content: "Uncompacted suffix",
        },
    ]
    const checkpoint: ICompactionCheckpoint = {
        id: "checkpoint-1",
        sessionId: "default",
        createdAt: 3,
        reason: "automatic",
        compactedMessageCount: 1,
        throughMessageId: "compacted-user",
        summary: [
            "# Checkpoint summary",
            "",
            "- Preserved detail",
            "",
            "```diff",
            "--- a/src/value.ts",
            "+++ b/src/value.ts",
            "@@ -1 +1 @@",
            "-const value = 1",
            "+const value = 2",
            "```",
        ].join("\n"),
    }
    const setup = await testRender(<Transcript
        messages={messages}
        compactionCheckpoint={checkpoint}
        streamingMessage={{
            id: "live-assistant",
            sessionId: "default",
            runId: "run-live",
            role: "assistant",
            createdAt: 4,
            stopReason: "pending",
            content: [{ type: "text", text: "Live response" }],
        }}
    />, {
        width: 80,
        height: 20,
    })

    try {
        await act(async () => {
            await setup.renderOnce()
            await Promise.all(
                codeRenderables(setup.renderer.root).map((renderable) =>
                    renderable.highlightingDone
                ),
            )
            await setup.renderOnce()
        })

        const frame = setup.captureCharFrame()
        const compactedIndex = frame.indexOf("Compacted prefix")
        const checkpointIndex = frame.indexOf("Context compacted")
        const suffixIndex = frame.indexOf("Uncompacted suffix")
        const liveIndex = frame.indexOf("Live response")
        expect(compactedIndex).toBeGreaterThanOrEqual(0)
        expect(checkpointIndex).toBeGreaterThan(compactedIndex)
        expect(frame).toContain("Checkpoint summary")
        expect(frame).toContain("Preserved detail")
        expect(suffixIndex).toBeGreaterThan(checkpointIndex)
        expect(liveIndex).toBeGreaterThan(suffixIndex)

        const markdown = markdownRenderables(setup.renderer.root)
        expect(markdown).toHaveLength(2)
        expect(markdown[0]?.content).toBe(checkpoint.summary)
        expect(markdown[0]?.syntaxStyle).toBe(syntax)
        expect(markdown[0]?.conceal).toBe(true)
        expect(markdown[0]?.concealCode).toBe(false)
        expect(markdown[0]?.internalBlockMode).toBe("top-level")
        expect(markdown[0]?.renderNode).toBeFunction()
        expect(markdown[0]?.tableOptions).toEqual(expect.objectContaining({
            style: "grid",
            widthMode: "full",
        }))
        const checkpointDiffs = diffRenderables(setup.renderer.root)
        expect(checkpointDiffs).toHaveLength(1)
        expect(checkpointDiffs[0]?.diff).toContain("@@ -1 +1 @@")
        expect(checkpointDiffs[0]?.diff).toContain("+const value = 2")
    } finally {
        act(() => {
            setup.renderer.destroy()
        })
    }
})

test("streams a checkpoint at its anchor and finalizes the same Markdown renderable", async () => {
    const messages: TAgentMessage[] = [
        {
            id: "anchor", sessionId: "default", runId: "old", role: "assistant",
            createdAt: 1, stopReason: "stop", content: [{ type: "text", text: "Durable answer" }],
        },
        {
            id: "pending", sessionId: "default", runId: "new", role: "user",
            createdAt: 2, source: "prompt", content: "Pending prompt",
        },
    ]
    const previous: ICompactionCheckpoint = {
        id: "previous", sessionId: "default", createdAt: 1, reason: "manual",
        compactedMessageCount: 1, throughMessageId: "anchor", summary: "Previous checkpoint",
    }
    const progress: ICompactionProgress = {
        id: "candidate", throughMessageId: "anchor", summary: "# Stable heading\n\nPartial",
    }
    type View = { compactionCheckpoint: ICompactionCheckpoint; compactionProgress?: ICompactionProgress }
    let update: ((view: View) => void) | undefined
    function StreamingCheckpoint(): React.ReactNode {
        const [view, setView] = useState<View>({ compactionCheckpoint: previous, compactionProgress: progress })
        update = setView
        return <Transcript messages={messages} {...view} streamingMessage={{
            id: "live", sessionId: "default", runId: "new", role: "assistant",
            createdAt: 3, stopReason: "pending", content: [{ type: "text", text: "Live response" }],
        }} />
    }
    const setup = await testRender(<StreamingCheckpoint />, { width: 80, height: 18 })
    try {
        await act(async () => { await setup.renderOnce() })
        const before = markdownRenderables(setup.renderer.root)
        expect(before).toHaveLength(3)
        const preview = before[1]!
        const heading = preview._blockStates[0]?.renderable
        expect(heading).toBeDefined()
        expect(preview.streaming).toBe(true)
        expect(preview.content).toBe(progress.summary)
        const frame = setup.captureCharFrame()
        expect(frame).not.toContain("Previous checkpoint")
        expect(frame).not.toContain("Context compacted")
        expect(frame.indexOf("Compacting context")).toBeGreaterThan(frame.indexOf("Durable answer"))
        expect(frame.indexOf("Pending prompt")).toBeGreaterThan(frame.indexOf("Partial"))
        expect(frame.indexOf("Live response")).toBeGreaterThan(frame.indexOf("Pending prompt"))
        const expanded = { ...progress, summary: progress.summary + " continues" }
        act(() => update?.({ compactionCheckpoint: previous, compactionProgress: expanded }))
        await act(async () => { await setup.renderOnce() })
        const during = markdownRenderables(setup.renderer.root)
        expect(during[0]).toBe(before[0])
        expect(during[1]).toBe(preview)
        expect(during[2]).toBe(before[2])
        expect(preview._blockStates[0]?.renderable).toBe(heading)
        expect(setup.captureCharFrame()).toContain("Partial continues")
        act(() => update?.({ compactionCheckpoint: { ...previous, ...expanded } }))
        await act(async () => { await setup.renderOnce() })
        const after = markdownRenderables(setup.renderer.root)
        expect(after).toHaveLength(3)
        expect(after[1]).toBe(preview)
        expect(preview.streaming).toBe(false)
        expect(preview.content).toBe(expanded.summary)
        expect(setup.captureCharFrame()).toContain("Context compacted")
        expect(setup.captureCharFrame()).not.toContain("Compacting context")
    } finally {
        act(() => setup.renderer.destroy())
    }
})

test.each([false, true])("restores the previous checkpoint or empty transcript when progress is discarded (previous: %s)", async (hasPrevious) => {
    let clear: (() => void) | undefined
    function DiscardedCheckpoint(): React.ReactNode {
        const [active, setActive] = useState(true)
        clear = () => setActive(false)
        return <Transcript messages={[]} {...(hasPrevious ? { compactionCheckpoint: {
            id: "previous", sessionId: "default", createdAt: 1, reason: "manual" as const,
            compactedMessageCount: 1, throughMessageId: "missing", summary: "Previous checkpoint",
        } } : {})} {...(active ? { compactionProgress: {
            id: "candidate", throughMessageId: "missing", summary: "Unaccepted preview",
        } } : {})} />
    }
    const setup = await testRender(<DiscardedCheckpoint />, { width: 80, height: 8 })
    try {
        await act(async () => { await setup.renderOnce() })
        expect(setup.captureCharFrame()).toContain("Unaccepted preview")
        expect(setup.captureCharFrame()).not.toContain("Previous checkpoint")
        expect(setup.captureCharFrame()).not.toContain("Start conversation")
        act(() => clear?.())
        await act(async () => {
            await setup.renderOnce()
            await Promise.all(codeRenderables(setup.renderer.root).map(
                (renderable) => renderable.highlightingDone,
            ))
            await setup.renderOnce()
        })
        expect(setup.captureCharFrame()).not.toContain("Unaccepted preview")
        expect(setup.captureCharFrame()).not.toContain("Compacting context")
        expect(setup.captureCharFrame()).toContain(hasPrevious ? "Previous checkpoint" : "Start conversation")
        expect(markdownRenderables(setup.renderer.root)).toHaveLength(hasPrevious ? 1 : 0)
    } finally {
        act(() => setup.renderer.destroy())
    }
})

test("uses streaming diff fallback in a compaction preview until its fence closes", async () => {
    let closeFence: (() => void) | undefined
    const patch = "--- a/value.ts\n+++ b/value.ts\n@@ -1 +1 @@\n-const value = 1\n+const value = 2"
    function CompactionDiff(): React.ReactNode {
        const [closed, setClosed] = useState(false)
        closeFence = () => setClosed(true)
        return <Transcript messages={[]} compactionProgress={{
            id: "candidate", throughMessageId: "missing",
            summary: `\`\`\`diff\n${patch}${closed ? "\n```" : ""}`,
        }} />
    }
    const setup = await testRender(<CompactionDiff />, { width: 80, height: 12 })
    try {
        await act(async () => { await setup.renderOnce() })
        const markdown = markdownRenderables(setup.renderer.root)[0]
        expect(markdown?.streaming).toBe(true)
        expect(diffRenderables(setup.renderer.root)).toHaveLength(0)
        const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
        expect(spans.find((span) => span.text.includes("-const value = 1"))?.fg.equals(RGBA.fromHex(theme.red))).toBe(true)
        expect(spans.find((span) => span.text.includes("+const value = 2"))?.fg.equals(RGBA.fromHex(theme.green))).toBe(true)
        act(() => closeFence?.())
        await act(async () => { await setup.renderOnce() })
        expect(markdownRenderables(setup.renderer.root)[0]).toBe(markdown)
        expect(diffRenderables(setup.renderer.root)).toHaveLength(1)
        expect(diffRenderables(setup.renderer.root)[0]?.diff).toBe(patch)
    } finally {
        act(() => setup.renderer.destroy())
    }
})

test("treats a checkpoint-only transcript as non-empty", async () => {
    const setup = await testRender(<Transcript
        messages={[]}
        compactionCheckpoint={{
            id: "checkpoint-only",
            sessionId: "default",
            createdAt: 1,
            reason: "manual",
            compactedMessageCount: 1,
            throughMessageId: "persisted-anchor",
            summary: "Checkpoint without loaded messages",
        }}
    />, {
        width: 80,
        height: 8,
    })

    try {
        await act(async () => {
            await setup.renderOnce()
            await Promise.all(
                codeRenderables(setup.renderer.root).map((renderable) =>
                    renderable.highlightingDone
                ),
            )
            await setup.renderOnce()
        })
        const frame = setup.captureCharFrame()
        expect(frame).toContain("Context compacted")
        expect(frame).toContain("Checkpoint without loaded messages")
        expect(frame).not.toContain("Start conversation")
    } finally {
        act(() => {
            setup.renderer.destroy()
        })
    }
})

test("styles rich Markdown and renders code without line numbers", async () => {
    const message: IAssistantMessage = {
        id: "styled-markdown",
        sessionId: "default",
        runId: "run-styled-markdown",
        role: "assistant",
        createdAt: 1,
        stopReason: "stop",
        content: [{
            type: "text",
            text: [
                "# Styled heading",
                "",
                "- Listed item",
                "",
                "> Quoted text",
                "",
                "| Column | Status |",
                "| --- | --- |",
                "| Mode | ready |",
                "",
                "Use `inline` code.",
                "",
                "```typescript",
                "const answer: number = 42",
                "console.log(answer)",
                "```",
                "",
                "```python",
                "print('ready')",
                "```",
                "",
                "```bash",
                "echo first",
                "echo second",
                "```",
                "",
                "```diff",
                "-before",
                "+after",
                "```",
            ].join("\n"),
        }],
    }
    const setup = await testRender(<Transcript messages={[message]} />, {
        width: 80,
        height: 40,
    })

    try {
        await act(async () => {
            await setup.renderOnce()
            await Promise.all(
                codeRenderables(setup.renderer.root).map((renderable) =>
                    renderable.highlightingDone
                ),
            )
            await setup.renderOnce()
        })

        const markdown = markdownRenderables(setup.renderer.root)[0]
        expect(markdown?.syntaxStyle).toBe(syntax)
        expect(markdown?.conceal).toBe(true)
        expect(markdown?.concealCode).toBe(false)
        expect(markdown?.internalBlockMode).toBe("top-level")
        expect(markdown?.renderNode).toBeFunction()

        const tables = tableRenderables(setup.renderer.root)
        expect(tables).toHaveLength(1)
        expect(tables[0]?.wrapMode).toBe("word")
        expect(tables[0]?.columnWidthMode).toBe("full")
        expect(tables[0]?.columnFitter).toBe("proportional")
        expect(tables[0]?.borderColor.equals(RGBA.fromHex(theme.textMuted))).toBe(true)

        const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
        const heading = spans.find((span) => span.text.includes("Styled heading"))
        const listMarker = spans.find((span) => span.text.trim() === "-")
        const quote = spans.find((span) => span.text.includes("Quoted text"))
        const tableHeading = spans.find((span) => span.text.includes("Column"))
        const inlineCode = spans.find((span) => span.text.includes("inline"))
        expect(heading?.fg.equals(RGBA.fromHex(theme.amber))).toBe(true)
        expect((heading?.attributes ?? 0) & TextAttributes.BOLD).toBeTruthy()
        expect(listMarker?.fg.equals(RGBA.fromHex(theme.green))).toBe(true)
        expect(quote?.fg.equals(RGBA.fromHex(theme.textMuted))).toBe(true)
        expect((quote?.attributes ?? 0) & TextAttributes.ITALIC).toBeTruthy()
        expect(tableHeading?.fg.equals(RGBA.fromHex(theme.amber))).toBe(true)
        expect((tableHeading?.attributes ?? 0) & TextAttributes.BOLD).toBeTruthy()
        expect(inlineCode?.fg.equals(RGBA.fromHex(theme.amber))).toBe(true)
        expect(inlineCode?.bg.equals(RGBA.fromHex(theme.surface))).toBe(true)

        const fencedCode = codeRenderables(setup.renderer.root).filter(
            (renderable) => renderable.filetype !== "markdown",
        )
        expect(fencedCode.map((renderable) => renderable.filetype)).toEqual([
            "typescript",
            "python",
            "bash",
        ])
        expect(fencedCode.every((renderable) => renderable.syntaxStyle === syntax))
            .toBe(true)

        expect(spans.find((span) => span.text.includes("-before"))?.fg.equals(RGBA.fromHex(theme.red))).toBe(true)
        expect(spans.find((span) => span.text.includes("+after"))?.fg.equals(RGBA.fromHex(theme.green))).toBe(true)
        expect(lineNumberRenderables(setup.renderer.root)).toHaveLength(0)
    } finally {
        act(() => {
            setup.renderer.destroy()
        })
    }
})

test("keeps unnumbered code readable in a narrow transcript", async () => {
    const message: IAssistantMessage = {
        id: "narrow-code",
        sessionId: "default",
        runId: "run-narrow-code",
        role: "assistant",
        createdAt: 1,
        stopReason: "stop",
        content: [{
            type: "text",
            text: "```typescript\nconst one = 1\nconst two = 2\n```",
        }],
    }
    const setup = await testRender(<Transcript messages={[message]} />, {
        width: 18,
        height: 6,
    })

    try {
        await act(async () => {
            await setup.renderOnce()
        })

        expect(lineNumberRenderables(setup.renderer.root)).toHaveLength(0)
        const frame = setup.captureCharFrame()
        expect(frame).toContain("const one = 1")
        expect(frame).toContain("const two = 2")
    } finally {
        act(() => {
            setup.renderer.destroy()
        })
    }
})
