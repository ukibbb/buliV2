import { expect, test } from "bun:test"
import { CodeRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"

import type { IAssistantMessage, TAgentMessage } from "@/domain"
import { Transcript } from "@/tui/components/Transcript"

function codeRenderables(root: Renderable): CodeRenderable[] {
  return root.getChildren().flatMap((child) => [
    ...(child instanceof CodeRenderable ? [child] : []),
    ...codeRenderables(child),
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
      id: "failed-assistant-message",
      sessionId: "default",
      runId: "run-2",
      role: "assistant",
      createdAt: 5,
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
    createdAt: 6,
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
    expect(frame).toContain("Streaming answer")
    expect(frame).toContain("[running] glob")
    expect(frame).toContain("TypeError: Invalid OpenAI authentication")
    expect(frame).not.toContain("Hidden reasoning")
    expect(frame).not.toContain("Streaming hidden reasoning")
    expect(frame).not.toContain("src/session/agent-session.ts:28")
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})
