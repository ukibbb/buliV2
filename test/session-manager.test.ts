import { expect, test } from "bun:test"

import type { IBuliMessageWithParts } from "@/domain"
import { InMemorySessionManager } from "@/session/session-manager"

test("stores independent copies and replaces durable messages by ID", () => {
  const manager = new InMemorySessionManager()
  const original = userMessage("First")

  manager.appendMessage(original)
  const originalPart = original.parts[0]
  if (originalPart?.type === "text") {
    ;(originalPart as { text: string }).text = "Mutated outside manager"
  }

  expect(manager.getMessages("session-1")[0]?.parts[0]).toMatchObject({
    text: "First",
  })

  manager.appendMessage(userMessage("Replacement"))
  const returned = manager.getMessages("session-1")
  const returnedPart = returned[0]?.parts[0]
  if (returnedPart?.type === "text") {
    ;(returnedPart as { text: string }).text = "Mutated returned copy"
  }

  expect(manager.getMessages("session-1")).toHaveLength(1)
  expect(manager.getMessages("session-1")[0]?.parts[0]).toMatchObject({
    text: "Replacement",
  })
})

test("keeps structured tool input and output independent", () => {
  const manager = new InMemorySessionManager()
  manager.appendMessage(completedAssistant([{
    id: "tool-1",
    messageId: "assistant-1",
    sessionId: "session-1",
    createdAt: 1,
    type: "tool",
    callID: "call-1",
    tool: "grep",
    status: "completed",
    input: { pattern: "Agent" },
    output: { matches: ["src/agent/agent.ts"] },
    execution: "local",
  }]))

  const first = manager.getMessages("session-1")[0]?.parts[0]
  if (
    first?.type !== "tool"
    || !first.output
    || Array.isArray(first.output)
    || typeof first.output !== "object"
  ) {
    throw new Error("Expected structured tool output")
  }
  ;(first.input as { pattern: string }).pattern = "mutated"
  ;(first.output.matches as string[]).push("mutated")

  expect(manager.getMessages("session-1")[0]?.parts[0]).toMatchObject({
    input: { pattern: "Agent" },
    output: { matches: ["src/agent/agent.ts"] },
  })
})

test("rejects incomplete assistants and invalid part ownership", () => {
  const manager = new InMemorySessionManager()

  expect(() => manager.appendMessage({
    ...completedAssistant([]),
    info: {
      id: "assistant-1",
      sessionId: "session-1",
      role: "assistant",
      createdAt: 1,
    },
  })).toThrow("Cannot persist an incomplete assistant message")

  expect(() => manager.appendMessage({
    ...userMessage("Invalid"),
    parts: [{
      id: "part-1",
      messageId: "other-message",
      sessionId: "session-1",
      createdAt: 1,
      type: "text",
      text: "Invalid",
    }],
  })).toThrow("belongs to another message")
})

test("resets only the selected session", () => {
  const manager = new InMemorySessionManager()
  manager.appendMessage(userMessage("First", "session-1", "user-1"))
  manager.appendMessage(userMessage("Second", "session-2", "user-2"))

  manager.resetSession("session-1")

  expect(manager.getMessages("session-1")).toEqual([])
  expect(manager.getMessages("session-2")).toHaveLength(1)
})

function userMessage(
  text: string,
  sessionId = "session-1",
  messageId = "message-1",
): IBuliMessageWithParts {
  return {
    info: {
      id: messageId,
      sessionId,
      role: "user",
      createdAt: 1,
    },
    parts: [{
      id: `${messageId}-part`,
      messageId,
      sessionId,
      createdAt: 1,
      type: "text",
      text,
    }],
  }
}

function completedAssistant(
  parts: IBuliMessageWithParts["parts"],
): IBuliMessageWithParts {
  return {
    info: {
      id: "assistant-1",
      sessionId: "session-1",
      role: "assistant",
      createdAt: 1,
      completedAt: 2,
      finish: "stop",
    },
    parts,
  }
}
