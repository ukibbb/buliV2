import { expect, test } from "bun:test"
import {
    CodeRenderable,
    LineNumberRenderable,
    MarkdownRenderable,
    RGBA,
    type Renderable,
    TextAttributes,
    TextRenderable,
    TextTableRenderable,
} from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { act, useState } from "react"

import type { AgentMessage, AssistantMessage } from "@/agent"
import { Transcript } from "@/sessions/ui"
import { syntax, theme } from "@/terminal/theme"

function codeRenderables(root: Renderable): CodeRenderable[] {
    return root.getChildren().flatMap((child) => [
        ...(child instanceof CodeRenderable ? [child] : []),
        ...codeRenderables(child),
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

test("renders direct, streaming, and tool messages", async () => {
    const messages: AgentMessage[] = [
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
                    input: { patchText: "*** Begin Patch", explanation: "Test rejection" },
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
                    input: { patchText: "*** Begin Patch", explanation: "Test abort" },
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
    const streamingMessage: AssistantMessage = {
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
                toolCallId: "call-glob",
                toolName: "glob",
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
        expect(frame).toContain("Glob [**/*.ts]")
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
    const message: AssistantMessage = {
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
                    purpose: "Verify the project",
                    cwd: "src",
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
                toolCallId: "call-glob",
                toolName: "glob",
                input: { pattern: "**/*.ts", path: "src", hidden: true, limit: 25 },
            },
            {
                type: "toolCall",
                toolCallId: "call-grep",
                toolName: "grep",
                input: {
                    pattern: "AgentSession",
                    path: "src",
                    include: "*.ts",
                    literal: true,
                    caseSensitive: false,
                    context: 2,
                    limit: 25,
                },
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
            "Bash [bun test] cwd=src timeout=30",
            "Read [src/app.ts] offset=20 limit=40",
            "Glob [**/*.ts] path=src hidden=true limit=25",
            "Grep [AgentSession] path=src include=*.ts literal=true caseSensitive=false context=2 limit=25",
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
        const messages: AgentMessage[] = [
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
        const assistant: AssistantMessage = {
            id: "streaming-tool",
            sessionId: "default",
            runId: "run-streaming-tool",
            role: "assistant",
            createdAt: 1,
            stopReason: persisted ? "tool-use" : "pending",
            content: [{
                type: "toolCall",
                toolCallId: "call-glob",
                toolName: "glob",
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
        expect(lineBefore?.plainText).toBe("Glob [**/*.tsx]")

        act(() => {
            persistAssistant?.()
        })
        await act(async () => {
            await setup.renderOnce()
        })

        const linesAfter = textRenderables(setup.renderer.root)
        expect(linesAfter).toHaveLength(1)
        expect(linesAfter[0]).toBe(lineBefore)
        expect(linesAfter[0]?.plainText).toBe("Glob [**/*.tsx]")
    } finally {
        act(() => {
            setup.renderer.destroy()
        })
    }
})

test("truncates tool targets without splitting Unicode code points", async () => {
    const path = `${"a".repeat(92)}😀tail`
    const message: AssistantMessage = {
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
    const assistant: AssistantMessage = {
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
    const messages: AgentMessage[] = [
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
    const messages: AgentMessage[] = [
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
    const messages: AgentMessage[] = [
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
    const completedMessage: AssistantMessage = {
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
    const streamingMessage: AssistantMessage = {
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
        expect(streamingReasoning?.fg.equals(RGBA.fromHex(theme.amber))).toBe(true)
        expect(streamingReasoning?.wrapMode).toBe("word")
        expect(streamingReasoning?.truncate).toBe(false)
        expect(markdownRenderables(setup.renderer.root)).toHaveLength(2)

        const frame = setup.captureCharFrame()
        expect(frame).toContain("**literal Markdown syntax**")
        expect(frame.indexOf("Before summary")).toBeLessThan(frame.indexOf("Thought:"))
        expect(frame.indexOf("Thought:")).toBeLessThan(frame.indexOf("After summary"))
    } finally {
        act(() => {
            setup.renderer.destroy()
        })
    }
})

test("shows work for empty streaming reasoning and hides empty completed reasoning", async () => {
    const completedMessage: AssistantMessage = {
        id: "empty-completed-reasoning",
        sessionId: "default",
        runId: "run-empty-completed-reasoning",
        role: "assistant",
        createdAt: 1,
        stopReason: "stop",
        content: [{ type: "reasoning", text: "" }],
    }
    const streamingMessage: AssistantMessage = {
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
        expect(reasoning[0]?.fg.equals(RGBA.fromHex(theme.amber))).toBe(true)
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
        const streamingMessage: AssistantMessage = {
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
        expect(markdownBefore?.renderNode).toBeUndefined()
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

test("keeps completed history renderables stable across streaming text updates", async () => {
    let updateText: ((text: string) => void) | undefined
    const messages: AgentMessage[] = [
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
        height: 12,
    })

    try {
        await act(async () => {
            await setup.renderOnce()
        })
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

test("styles rich Markdown and renders code without line numbers", async () => {
    const message: AssistantMessage = {
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
        expect(markdown?.renderNode).toBeUndefined()

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
            "diff",
        ])
        expect(fencedCode.every((renderable) => renderable.syntaxStyle === syntax))
            .toBe(true)

        expect(lineNumberRenderables(setup.renderer.root)).toHaveLength(0)
    } finally {
        act(() => {
            setup.renderer.destroy()
        })
    }
})

test("keeps unnumbered code readable in a narrow transcript", async () => {
    const message: AssistantMessage = {
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
