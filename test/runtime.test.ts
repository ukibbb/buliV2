import { expect, test } from "bun:test"

import { BuliPromptsHandler } from "@/engine/prompts-handler"
import { SessionEngine, type ISessionPromptInput } from "@/engine/session-engine"
import { OpenAiUserBuliInteractionDriver } from "@/providers/openai"
import {
  BuliApplicationRuntime,
  type IBuliPromptInput,
} from "@/runtime"

test("maps application prompts to session prompts", async () => {
  let receivedInput: ISessionPromptInput | undefined
  const handler = new BuliPromptsHandler({
    sessions: {
      prompt: async (input) => {
        receivedInput = input
        return undefined
      },
    },
  })

  await handler.submitPrompt({ sessionId: "session-1", text: "Hello" })

  expect(receivedInput).toEqual({
    sessionId: "session-1",
    parts: [{ type: "text", text: "Hello" }],
  })
})

test("application runtime delegates prompts through its session engine", async () => {
  const sessions = new SessionEngine({
    driver: new OpenAiUserBuliInteractionDriver(),
  })
  const runtime = new BuliApplicationRuntime({ sessions })
  const input: IBuliPromptInput = { sessionId: "session-1", text: "Hello" }
  let receivedInput: IBuliPromptInput | undefined

  runtime.prompts.submitPrompt = async (prompt) => {
    receivedInput = prompt
  }

  await runtime.submitPrompt(input)

  expect(runtime.prompts.sessions).toBe(sessions)
  expect(receivedInput).toEqual(input)
})
