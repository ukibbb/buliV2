import { expect, test } from "bun:test"

import type {
  IAssistantMessage,
  IToolResultMessage,
  IUserMessage,
  TAgentMessage,
} from "@/domain"
import { InMemorySessionManager } from "@/session/session-manager"

test("stores independent copies and replaces durable messages by ID", () => {
  const manager = new InMemorySessionManager()
  const original = userMessage("First")

  manager.appendMessage(original)
  const mutableOriginal = original as { content: string }
  mutableOriginal.content = "Mutated outside manager"

  expect(manager.getMessages("session-1")[0]).toMatchObject({
    content: "First",
  })

  manager.appendMessage(userMessage("Replacement"))
  const returned = manager.getMessages("session-1")
  const returnedMessage = returned[0]
  if (returnedMessage?.role === "user") {
    const mutableReturned = returnedMessage as { content: string }
    mutableReturned.content = "Mutated returned copy"
  }

  expect(manager.getMessages("session-1")).toHaveLength(1)
  expect(manager.getMessages("session-1")[0]).toMatchObject({
    content: "Replacement",
  })
})

test("keeps structured tool input and tool results independent", () => {
  const manager = new InMemorySessionManager()
  manager.appendMessage(completedAssistant([{
    type: "toolCall",
    toolCallId: "call-1",
    toolName: "grep",
    input: { pattern: "Agent" },
  }]))
  manager.appendMessage(toolResultMessage("src/agent/agent.ts"))

  const returned = manager.getMessages("session-1")
  const assistant = returned[0]
  if (assistant?.role !== "assistant") {
    throw new Error("Expected assistant message")
  }
  const toolCall = assistant.content[0]
  if (toolCall?.type !== "toolCall") {
    throw new Error("Expected tool call")
  }
  const toolResult = returned[1]
  if (toolResult?.role !== "toolResult") {
    throw new Error("Expected tool result")
  }
  const mutableInput = toolCall.input as { pattern: string }
  mutableInput.pattern = "mutated"
  const mutableToolResult = toolResult as { content: string }
  mutableToolResult.content = "mutated"

  expect(manager.getMessages("session-1")).toEqual([
    completedAssistant([{
      type: "toolCall",
      toolCallId: "call-1",
      toolName: "grep",
      input: { pattern: "Agent" },
    }]),
    toolResultMessage("src/agent/agent.ts"),
  ])
})

test("rejects incomplete assistants and invalid direct messages", () => {
  const manager = new InMemorySessionManager()

  expect(() => manager.appendMessage({
    ...completedAssistant([]),
    stopReason: "pending",
  })).toThrow("Cannot persist an incomplete assistant message")

  expect(() => manager.appendMessage({
    ...toolResultMessage("Result"),
    isError: "false",
  } as unknown as TAgentMessage)).toThrow("Invalid tool result message")
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
  content: string,
  sessionId = "session-1",
  id = "message-1",
): IUserMessage {
  return {
    id,
    sessionId,
    role: "user",
    content,
    createdAt: 1,
  }
}

function completedAssistant(
  content: IAssistantMessage["content"],
): IAssistantMessage {
  return {
    id: "assistant-1",
    sessionId: "session-1",
    role: "assistant",
    content,
    stopReason: "stop",
    createdAt: 1,
  }
}

function toolResultMessage(content: string): IToolResultMessage {
  return {
    id: "tool-result-1",
    sessionId: "session-1",
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "grep",
    content,
    isError: false,
    createdAt: 2,
  }
}
