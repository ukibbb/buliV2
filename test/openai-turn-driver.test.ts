import { expect, test } from "bun:test"
import type { ModelMessage } from "ai"

import type { IBuliMessageWithParts } from "@/domain"
import { OpenAiUserBuliInteractionDriver } from "@/providers/openai"
import type { streamOpenAiText } from "@/providers"

test("maps session history and OpenAI stream events", async () => {
  let capturedMessages: ModelMessage[] | undefined
  const stream = async (messages: ModelMessage[]) => {
    capturedMessages = messages

    return {
      stream: (async function* () {
        yield { type: "text-start", id: "answer" }
        yield { type: "text-delta", id: "answer", text: "Hello" }
        yield { type: "text-end", id: "answer" }
        yield { type: "finish", finishReason: "stop", rawFinishReason: undefined }
      })(),
    } as unknown as Awaited<ReturnType<typeof streamOpenAiText>>
  }
  const driver = new OpenAiUserBuliInteractionDriver(
    stream as typeof streamOpenAiText,
  )
  const history: IBuliMessageWithParts[] = [
    message("user", [
      part("text", " First "),
      part("reasoning", "Do not send this"),
      part("text", "Second"),
    ]),
    message("assistant", [part("text", "Answer")]),
  ]

  const events = []
  for await (const event of driver.interaction({
    sessionId: "session-1",
    history,
  })) {
    events.push(event)
  }

  expect(capturedMessages).toEqual([
    { role: "user", content: "First \n\nSecond" },
    { role: "assistant", content: "Answer" },
  ])
  expect(events).toEqual([
    { type: "text-start", id: "answer" },
    { type: "text-delta", id: "answer", delta: "Hello" },
    { type: "text-end", id: "answer" },
    { type: "finish", reason: "stop" },
  ])
})

function message(
  role: "user" | "assistant",
  parts: IBuliMessageWithParts["parts"],
): IBuliMessageWithParts {
  return {
    info: {
      id: `${role}-message`,
      sessionId: "session-1",
      role,
      createdAt: 1,
    },
    parts,
  }
}

function part(
  type: "text" | "reasoning",
  text: string,
): IBuliMessageWithParts["parts"][number] {
  return {
    id: `${type}-${text}`,
    messageId: "message",
    sessionId: "session-1",
    createdAt: 1,
    type,
    text,
  }
}
