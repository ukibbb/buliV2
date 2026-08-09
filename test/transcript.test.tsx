import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"

import type { IBuliMessageWithParts } from "@/domain"
import { Transcript } from "@/tui/components/Transcript"

test("renders user and assistant text while keeping reasoning hidden", async () => {
  const messages: IBuliMessageWithParts[] = [
    {
      info: {
        id: "user-message",
        sessionId: "default",
        role: "user",
        createdAt: 1,
      },
      parts: [
        {
          id: "user-part",
          messageId: "user-message",
          sessionId: "default",
          createdAt: 1,
          type: "text",
          text: "  User prompt  ",
        },
      ],
    },
    {
      info: {
        id: "assistant-message",
        sessionId: "default",
        role: "assistant",
        createdAt: 2,
        completedAt: 3,
        finish: "stop",
      },
      parts: [
        {
          id: "reasoning-part",
          messageId: "assistant-message",
          sessionId: "default",
          createdAt: 2,
          type: "reasoning",
          text: "Hidden reasoning",
        },
        {
          id: "answer-part",
          messageId: "assistant-message",
          sessionId: "default",
          createdAt: 2,
          type: "text",
          text: "Assistant answer",
        },
      ],
    },
  ]
  const setup = await testRender(<Transcript messages={messages} />, {
    width: 60,
    height: 10,
  })

  try {
    await act(async () => {
      await setup.renderOnce()
    })

    const frame = setup.captureCharFrame()
    expect(frame).toContain("User prompt")
    expect(frame).toContain("Assistant answer")
    expect(frame).not.toContain("Hidden reasoning")
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})
