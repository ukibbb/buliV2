import { expect, test } from "bun:test"

import type { IAgentModel } from "@/agent/agent-types"
import type {
  IAssistantMessage,
  IToolResultMessage,
  IUserMessage,
} from "@/domain"
import { AgentSession } from "@/session/agent-session"
import {
  InMemorySessionManager,
  type ISessionManager,
} from "@/session/session-manager"

test("AgentSession restores history, persists completion barriers, and publishes stable snapshots", async () => {
  const manager = new InMemorySessionManager()
  manager.createSession(sessionInfo("session-1", "test-agent", "Restored"))
  manager.appendMessage(userMessage("Restored"))
  const persistedBeforeModel: number[] = []
  const model: IAgentModel = {
    async *stream() {
      persistedBeforeModel.push(manager.getMessages("session-1").length)
      yield { type: "text-start", id: "answer" }
      yield { type: "text-delta", id: "answer", delta: "Response" }
      yield { type: "text-end", id: "answer" }
      yield { type: "finish", reason: "stop" }
    },
  }
  const session = new AgentSession({
    agentId: "test-agent",
    sessionId: "session-1",
    manager,
    systemPrompt: "System",
    resolveRunConfiguration: () => ({
      model,
      reasoningEffort: "medium",
    }),
    tools: [],
  })
  expect(session.agentId).toBe("test-agent")
  const initial = session.getSnapshot()
  let notifications = 0
  session.subscribe(() => {
    notifications += 1
  })

  const run = session.prompt("Question")
  await run.accepted
  await run.settled

  expect(persistedBeforeModel).toEqual([2])
  expect(manager.getMessages("session-1")).toHaveLength(3)
  expect(session.getSnapshot()).not.toBe(initial)
  expect(session.getSnapshot()).toBe(session.getSnapshot())
  expect(session.getSnapshot().messages.map((message) => message.role)).toEqual([
    "user",
    "user",
    "assistant",
  ])
  expect(session.getSnapshot().messages.slice(1).every((message) =>
    message.runId === run.runId
  )).toBe(true)
  expect(session.getSnapshot().isRunning).toBe(false)
  expect(notifications).toBeGreaterThan(0)

  await session.dispose()
})

test("AgentSession clear removes one durable session without detaching subscribers", async () => {
  const manager = new InMemorySessionManager()
  manager.createSession(sessionInfo("session-1", "test-agent", "First"))
  manager.createSession(sessionInfo("session-2", "test-agent", "Other"))
  manager.appendMessage(userMessage("First", "session-1", "user-1"))
  manager.appendMessage(userMessage("Other", "session-2", "user-2"))
  const session = new AgentSession({
    agentId: "test-agent",
    sessionId: "session-1",
    manager,
    systemPrompt: "System",
    resolveRunConfiguration: () => ({
      model: { async *stream() {} },
      reasoningEffort: "medium",
    }),
    tools: [],
  })
  let notifications = 0
  session.subscribe(() => {
    notifications += 1
  })

  session.clear()

  expect(manager.getMessages("session-1")).toEqual([])
  expect(manager.getMessages("session-2")).toHaveLength(1)
  expect(session.getSnapshot().messages).toEqual([])
  expect(notifications).toBe(1)

  await session.dispose()
})

test("AgentSession rejects acceptance without invoking the provider or diverging from durable state", async () => {
  const memory = new InMemorySessionManager()
  memory.createSession(sessionInfo("session-1", "test-agent", "Failure"))
  const persistenceFailure = new Error("Disk write failed")
  const manager: ISessionManager = {
    createSession: memory.createSession,
    getSessionInfo: memory.getSessionInfo,
    listSessions: memory.listSessions,
    getMessages: memory.getMessages,
    appendMessage: () => {
      throw persistenceFailure
    },
    clearSession: memory.clearSession,
    deleteSession: memory.deleteSession,
  }
  let providerInvocations = 0
  const session = new AgentSession({
    agentId: "test-agent",
    sessionId: "session-1",
    manager,
    systemPrompt: "System",
    resolveRunConfiguration: () => ({
      model: {
        async *stream() {
          providerInvocations += 1
        },
      },
      reasoningEffort: "medium",
    }),
    tools: [],
  })

  const run = session.prompt("Question")
  const acceptanceFailure = run.accepted.then(
    () => undefined,
    (error: unknown) => error,
  )
  const settlementFailure = run.settled.then(
    () => undefined,
    (error: unknown) => error,
  )

  expect(await acceptanceFailure).toBe(persistenceFailure)
  expect(await settlementFailure).toBe(persistenceFailure)

  expect(providerInvocations).toBe(0)
  expect(session.getSnapshot().messages).toEqual(
    manager.getMessages("session-1"),
  )
  expect(session.getSnapshot().isRunning).toBe(false)

  await session.dispose()
})

test("AgentSession recovers one interrupted tool call deterministically without duplicating it on reopen", async () => {
  const manager = new InMemorySessionManager()
  manager.createSession(sessionInfo("session-1", "test-agent", "Interrupted"))
  const user = userMessage("Read the file")
  const assistant = interruptedAssistantMessage()
  manager.appendMessage(user)
  manager.appendMessage(assistant)
  const recovery = {
    id: "recovered-assistant-interrupted-call-read",
    sessionId: "session-1",
    runId: "run-interrupted",
    role: "toolResult" as const,
    toolCallId: "call-read",
    toolName: "read_file",
    content: "Tool execution was interrupted before a durable result was recorded.",
    isError: true,
    createdAt: 2,
  }

  const first = openAgentSession(manager)

  expect(manager.getMessages("session-1")).toEqual([user, assistant, recovery])
  expect(first.getSnapshot().messages).toEqual([user, assistant, recovery])
  await first.dispose()

  const reopened = openAgentSession(manager)

  expect(manager.getMessages("session-1")).toEqual([user, assistant, recovery])
  expect(reopened.getSnapshot().messages).toEqual([user, assistant, recovery])
  expect(manager.getMessages("session-1").filter((message) =>
    message.role === "toolResult" && message.toolCallId === "call-read"
  )).toHaveLength(1)

  await reopened.dispose()
})

test("AgentSession recovers a toolCallId reused by a later run", async () => {
  const manager = new InMemorySessionManager()
  manager.createSession(sessionInfo("session-1", "test-agent", "Reused call"))
  const firstUser = userMessage(
    "First run",
    "session-1",
    "user-run-1",
    "run-1",
    1,
  )
  const firstAssistant = toolCallAssistantMessage(
    "assistant-run-1",
    "run-1",
    "call-shared",
    2,
  )
  const firstResult: IToolResultMessage = {
    id: "tool-result-run-1",
    sessionId: "session-1",
    runId: "run-1",
    role: "toolResult",
    toolCallId: "call-shared",
    toolName: "read_file",
    content: "First result",
    isError: false,
    createdAt: 3,
  }
  const secondUser = userMessage(
    "Second run",
    "session-1",
    "user-run-2",
    "run-2",
    4,
  )
  const secondAssistant = toolCallAssistantMessage(
    "assistant-run-2",
    "run-2",
    "call-shared",
    5,
  )
  for (const message of [
    firstUser,
    firstAssistant,
    firstResult,
    secondUser,
    secondAssistant,
  ]) {
    manager.appendMessage(message)
  }

  const session = openAgentSession(manager)

  expect(manager.getMessages("session-1").at(-1)).toEqual({
    id: "recovered-assistant-run-2-call-shared",
    sessionId: "session-1",
    runId: "run-2",
    role: "toolResult",
    toolCallId: "call-shared",
    toolName: "read_file",
    content: "Tool execution was interrupted before a durable result was recorded.",
    isError: true,
    createdAt: 5,
  })
  expect(manager.getMessages("session-1").filter((message) =>
    message.role === "toolResult" && message.toolCallId === "call-shared"
  ).map((message) => message.runId)).toEqual(["run-1", "run-2"])
  expect(session.getSnapshot().messages).toEqual(
    manager.getMessages("session-1"),
  )

  await session.dispose()
})

test("AgentSession rejects an interrupted tool turn followed by a later message", () => {
  const laterMessages = [
    userMessage("Later user", "session-1", "later-user", "run-2", 3),
    textAssistantMessage("later-assistant", "run-2", "Later answer", 3),
  ]

  for (const laterMessage of laterMessages) {
    const manager = new InMemorySessionManager()
    manager.createSession(sessionInfo("session-1", "test-agent", "Invalid order"))
    manager.appendMessage(userMessage(
      "Use tool",
      "session-1",
      "user-run-1",
      "run-1",
      1,
    ))
    manager.appendMessage(toolCallAssistantMessage(
      "assistant-run-1",
      "run-1",
      "call-read",
      2,
    ))
    manager.appendMessage(laterMessage)
    const durableBeforeOpen = manager.getMessages("session-1")

    expect(() => openAgentSession(manager)).toThrow(
      "Interrupted tool turn must be the final turn in session session-1",
    )
    expect(manager.getMessages("session-1")).toEqual(durableBeforeOpen)
    expect(manager.getMessages("session-1").some((message) =>
      message.role === "toolResult"
    )).toBe(false)
  }
})

test("AgentSession suffixes a colliding recovery ID without replacing history", async () => {
  const manager = new InMemorySessionManager()
  manager.createSession(sessionInfo("session-1", "test-agent", "Collision"))
  const collidingId = "recovered-assistant-interrupted-call-read"
  const existing = userMessage(
    "Existing message",
    "session-1",
    collidingId,
    "run-before",
    1,
  )
  const assistant = interruptedAssistantMessage()
  manager.appendMessage(existing)
  manager.appendMessage(assistant)

  const session = openAgentSession(manager)

  expect(manager.getMessages("session-1")).toEqual([
    existing,
    assistant,
    {
      id: `${collidingId}-1`,
      sessionId: "session-1",
      runId: "run-interrupted",
      role: "toolResult",
      toolCallId: "call-read",
      toolName: "read_file",
      content: "Tool execution was interrupted before a durable result was recorded.",
      isError: true,
      createdAt: 2,
    },
  ])
  expect(manager.getMessages("session-1")[0]).toEqual(existing)
  expect(session.getSnapshot().messages).toEqual(
    manager.getMessages("session-1"),
  )

  await session.dispose()
})

test("AgentSession dispose times out and unsubscribes from a non-cooperative model", async () => {
  const manager = new InMemorySessionManager()
  manager.createSession(sessionInfo("session-1", "test-agent", "Blocked"))
  const modelStarted = Promise.withResolvers<void>()
  const releaseModel = Promise.withResolvers<void>()
  const session = new AgentSession({
    agentId: "test-agent",
    sessionId: "session-1",
    manager,
    systemPrompt: "System",
    resolveRunConfiguration: () => ({
      model: {
        async *stream() {
          modelStarted.resolve()
          await releaseModel.promise
          yield { type: "finish", reason: "stop" }
        },
      },
      reasoningEffort: "medium",
    }),
    tools: [],
    disposeTimeoutMs: 10,
  })
  let notifications = 0
  const unsubscribe = session.subscribe(() => {
    notifications += 1
  })
  const run = session.prompt("Question")
  const settlementFailure = run.settled.then(
    () => undefined,
    (error: unknown) => error,
  )
  await run.accepted
  await modelStarted.promise
  const notificationsBeforeDispose = notifications

  try {
    await expect(session.dispose()).rejects.toThrow(
      "Timed out waiting for AgentSession to stop",
    )
  } finally {
    releaseModel.resolve()
  }

  expect(await settlementFailure).toEqual(
    new Error("AgentSession stopped accepting events during shutdown"),
  )
  expect(notifications).toBe(notificationsBeforeDispose)
  expect(unsubscribe).not.toThrow()
  expect(() => session.subscribe(() => {})).toThrow("AgentSession is disposed")
})

function sessionInfo(id: string, agentId: string, title: string) {
  return {
    id,
    agentId,
    title,
    createdAt: 1,
    updatedAt: 1,
  }
}

function userMessage(
  content: string,
  sessionId = "session-1",
  id = "restored-user",
  runId = "run-restored",
  createdAt = 1,
): IUserMessage {
  return {
    id,
    sessionId,
    runId,
    role: "user",
    source: "prompt",
    content,
    createdAt,
  }
}

function openAgentSession(manager: ISessionManager): AgentSession {
  return new AgentSession({
    agentId: "test-agent",
    sessionId: "session-1",
    manager,
    systemPrompt: "System",
    resolveRunConfiguration: () => ({
      model: { async *stream() {} },
      reasoningEffort: "medium",
    }),
    tools: [],
  })
}

function toolCallAssistantMessage(
  id: string,
  runId: string,
  toolCallId: string,
  createdAt: number,
): IAssistantMessage {
  return {
    id,
    sessionId: "session-1",
    runId,
    role: "assistant",
    content: [{
      type: "toolCall",
      toolCallId,
      toolName: "read_file",
      input: { path: "README.md" },
    }],
    stopReason: "tool-calls",
    createdAt,
  }
}

function textAssistantMessage(
  id: string,
  runId: string,
  text: string,
  createdAt: number,
): IAssistantMessage {
  return {
    id,
    sessionId: "session-1",
    runId,
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    createdAt,
  }
}

function interruptedAssistantMessage(): IAssistantMessage {
  return {
    id: "assistant-interrupted",
    sessionId: "session-1",
    runId: "run-interrupted",
    role: "assistant",
    content: [{
      type: "toolCall",
      toolCallId: "call-read",
      toolName: "read_file",
      input: { path: "README.md" },
    }],
    stopReason: "tool-calls",
    createdAt: 2,
  }
}
