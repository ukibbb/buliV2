import { expect, test } from "bun:test"
import {
  CodeRenderable,
  RGBA,
  type Renderable,
  TextRenderable,
} from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"

import type { IAssistantMessage, TAgentMessage } from "@/domain"
import { Transcript } from "@/tui/components/Transcript"
import { theme } from "@/tui/theme"

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

test("renders direct, streaming, and tool messages", async () => {
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
          text: "Hidden reasoning",
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
      { type: "reasoning", text: "Streaming hidden reasoning" },
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
    pendingToolCallIds={["call-glob"]}
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
    expect(frame).toContain("[call] grep")
    expect(frame).toContain("[done] grep")
    expect(frame).toContain("[error] read_file")
    expect(frame).toContain("File not found")
    expect(frame).toContain("[rejected] apply_patch")
    expect(frame).toContain("User rejected the workspace patch")
    expect(frame).toContain("[manual] bash")
    expect(frame).toContain("Run the copied command manually")
    expect(frame).toContain("[committed-after-abort] apply_patch")
    expect(frame).toContain("Streaming answer")
    expect(frame).toContain("[running] glob")
    expect(frame).toContain("TypeError: Invalid OpenAI authentication")
    expect(frame).not.toContain("Hidden reasoning")
    expect(frame).not.toContain("Streaming hidden reasoning")
    expect(frame).not.toContain("src/session/agent-session.ts:28")
    const completedLine = textRenderables(setup.renderer.root).find((renderable) =>
      renderable.plainText.includes("[done] grep")
    )
    expect(completedLine?.plainText).toContain("Routine completion detail")
    const committedLine = textRenderables(setup.renderer.root).find((renderable) =>
      renderable.plainText.includes("[committed-after-abort]")
    )
    expect(committedLine?.plainText).toContain(
      "Workspace changes were committed despite cancellation",
    )
    expect(committedLine?.plainText).toContain("Patch commit completed")
    expect(committedLine?.fg.equals(RGBA.fromHex(theme.red))).toBe(true)
    const failedLine = textRenderables(setup.renderer.root).find((renderable) =>
      renderable.plainText.includes("[failed] bash")
    )
    expect(failedLine?.plainText).toContain("Command exited with code 7")
    expect(failedLine?.fg.equals(RGBA.fromHex(theme.red))).toBe(true)
    const unknownLine = textRenderables(setup.renderer.root).find((renderable) =>
      renderable.plainText.includes("[effects-unknown] bash")
    )
    expect(unknownLine?.plainText).toContain("Inspect current state before retrying")
    expect(unknownLine?.fg.equals(RGBA.fromHex(theme.red))).toBe(true)
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})
