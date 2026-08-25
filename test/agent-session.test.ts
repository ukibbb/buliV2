import { expect, test } from "bun:test"

import type {
  IAgentModel,
  IAgentModelRequest,
  IAgentTool,
  IAssistantMessage,
  IToolResultMessage,
  IUserMessage,
  TToolApprovalDecision,
} from "@/agent"
import {
  AgentSession,
  InMemorySessionManager,
  type ISessionManager,
} from "@/sessions"

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

test("AgentSession publishes immutable approval request and resolution snapshots", async () => {
  const manager = new InMemorySessionManager()
  manager.createSession(sessionInfo("session-1", "test-agent", "Approval"))
  const approvalStarted = Promise.withResolvers<void>()
  const decisions: TToolApprovalDecision[] = []
  const tool: IAgentTool = {
    name: "apply_patch",
    approvalKind: "patch",
    description: "Apply a patch",
    inputSchema: { type: "object", additionalProperties: false },
    async execute(_input, context) {
      if (!context.requestApproval) throw new Error("Missing approval bridge")
      const decisionTask = context.requestApproval({
        kind: "patch",
        title: "Apply changes",
        explanation: "Update the runtime",
        diff: "--- a/src/application/runtime.ts\n+++ b/src/application/runtime.ts",
        paths: ["src/application/runtime.ts"],
      })
      approvalStarted.resolve()
      const decision = await decisionTask
      decisions.push(decision)
      return decision
    },
  }
  let requestCount = 0
  const session = new AgentSession({
    agentId: "test-agent",
    sessionId: "session-1",
    manager,
    systemPrompt: "System",
    resolveRunConfiguration: () => ({
      model: {
        async *stream() {
          if (requestCount++ === 0) {
            yield {
              type: "tool-call",
              toolCallId: "patch-call",
              toolName: tool.name,
              input: {},
            }
            yield { type: "finish", reason: "tool-calls" }
            return
          }
          yield { type: "finish", reason: "stop" }
        },
      },
      reasoningEffort: "medium",
    }),
    tools: [tool],
  })
  const approvalTransitions: Array<string | undefined> = []
  let previousApprovalId: string | undefined
  session.subscribe(() => {
    const approvalId = session.getSnapshot().pendingToolApproval?.id
    if (approvalId === previousApprovalId) return
    previousApprovalId = approvalId
    approvalTransitions.push(approvalId)
  })

  const run = session.prompt("Apply the runtime patch")
  await approvalStarted.promise
  const waitingSnapshot = session.getSnapshot()
  const request = waitingSnapshot.pendingToolApproval
  if (!request || request.kind !== "patch") {
    throw new Error("Expected pending patch approval")
  }

  expect(request).toMatchObject({
    sessionId: "session-1",
    runId: run.runId,
    toolCallId: "patch-call",
    kind: "patch",
    paths: ["src/application/runtime.ts"],
  })
  expect(Object.isFrozen(waitingSnapshot)).toBe(true)
  expect(Object.isFrozen(request)).toBe(true)
  expect(Object.isFrozen(request.paths)).toBe(true)
  expect(() => (request.paths as string[]).push("src/domain.ts")).toThrow()
  expect(manager.getMessages("session-1").map((message) => message.role)).toEqual([
    "user",
    "assistant",
  ])

  session.resolveToolApproval(request.id, "approve")

  expect(session.getSnapshot().pendingToolApproval).toBeUndefined()
  expect(approvalTransitions).toEqual([request.id, undefined])
  await run.settled
  expect(decisions).toEqual(["approve"])
  expect(session.getSnapshot()).not.toHaveProperty("pendingToolApproval")

  await session.dispose()
})

test("AgentSession persists steering and follow-up before each model request", async () => {
  const manager = new InMemorySessionManager()
  manager.createSession(sessionInfo("session-1", "test-agent", "Steering"))
  const firstStarted = Promise.withResolvers<void>()
  const releaseFirst = Promise.withResolvers<void>()
  const requests: IAgentModelRequest[] = []
  const persistedBeforeRequest: number[] = []
  const model: IAgentModel = {
    async *stream(request) {
      requests.push({
        ...request,
        messages: structuredClone(request.messages),
        tools: structuredClone(request.tools),
      })
      persistedBeforeRequest.push(manager.getMessages("session-1").length)
      if (requests.length === 1) {
        firstStarted.resolve()
        await releaseFirst.promise
      }
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

  const run = session.prompt("Initial prompt")
  await run.accepted
  await firstStarted.promise
  session.steer("Adjust the answer")
  session.followUp("Then summarize it")

  expect(session.getSnapshot().pendingSteeringMessages).toEqual([
    expect.objectContaining({
      runId: run.runId,
      source: "steer",
      content: "Adjust the answer",
    }),
  ])
  expect(session.getSnapshot().pendingFollowUpMessages).toEqual([
    expect.objectContaining({
      runId: run.runId,
      source: "followUp",
      content: "Then summarize it",
    }),
  ])

  releaseFirst.resolve()
  await run.settled

  expect(requests).toHaveLength(3)
  expect(requests[1]?.messages.at(-1)).toMatchObject({
    runId: run.runId,
    source: "steer",
    content: "Adjust the answer",
  })
  expect(requests[2]?.messages.at(-1)).toMatchObject({
    runId: run.runId,
    source: "followUp",
    content: "Then summarize it",
  })
  expect(persistedBeforeRequest).toEqual([1, 3, 5])
  expect(manager.getMessages("session-1").map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "user",
    "assistant",
    "user",
    "assistant",
  ])
  expect(manager.getMessages("session-1")[2]).toMatchObject({
    runId: run.runId,
    source: "steer",
    content: "Adjust the answer",
  })
  expect(manager.getMessages("session-1")[4]).toMatchObject({
    runId: run.runId,
    source: "followUp",
    content: "Then summarize it",
  })
  expect(session.getSnapshot().pendingSteeringMessages).toEqual([])
  expect(session.getSnapshot().pendingFollowUpMessages).toEqual([])

  await session.dispose()
})

test("AgentSession restores steering to the queue when persistence fails", async () => {
  const memory = new InMemorySessionManager()
  memory.createSession(sessionInfo("session-1", "test-agent", "Steering failure"))
  const persistenceFailure = new Error("Failed to persist steering")
  const manager: ISessionManager = {
    createSession: memory.createSession,
    getSessionInfo: memory.getSessionInfo,
    listSessions: memory.listSessions,
    getMessages: memory.getMessages,
    appendMessage: (message) => {
      if (message.role === "user" && message.source === "steer") {
        throw persistenceFailure
      }
      memory.appendMessage(message)
    },
    getCompactionCheckpoint: memory.getCompactionCheckpoint,
    saveCompactionCheckpoint: memory.saveCompactionCheckpoint,
    deleteSession: memory.deleteSession,
  }
  const firstStarted = Promise.withResolvers<void>()
  const releaseFirst = Promise.withResolvers<void>()
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
          firstStarted.resolve()
          await releaseFirst.promise
          yield { type: "finish", reason: "stop" }
        },
      },
      reasoningEffort: "medium",
    }),
    tools: [],
  })

  const run = session.prompt("Initial prompt")
  await run.accepted
  await firstStarted.promise
  session.steer("Recover this steering")
  releaseFirst.resolve()
  const settlementFailure = await run.settled.then(
    () => undefined,
    (error: unknown) => error,
  )

  expect(settlementFailure).toBe(persistenceFailure)
  expect(providerInvocations).toBe(1)
  expect(memory.getMessages("session-1").map((message) => message.role)).toEqual([
    "user",
    "assistant",
  ])
  expect(session.getSnapshot().pendingSteeringMessages).toEqual([
    expect.objectContaining({
      runId: run.runId,
      source: "steer",
      content: "Recover this steering",
    }),
  ])
  expect(session.clearQueuedMessages()).toEqual({
    steering: ["Recover this steering"],
    followUp: [],
  })

  await session.dispose()
})

test("AgentSession restores follow-up to the queue when persistence fails", async () => {
  const memory = new InMemorySessionManager()
  memory.createSession(sessionInfo("session-1", "test-agent", "Follow-up failure"))
  const persistenceFailure = new Error("Failed to persist follow-up")
  const manager: ISessionManager = {
    createSession: memory.createSession,
    getSessionInfo: memory.getSessionInfo,
    listSessions: memory.listSessions,
    getMessages: memory.getMessages,
    appendMessage: (message) => {
      if (message.role === "user" && message.source === "followUp") {
        throw persistenceFailure
      }
      memory.appendMessage(message)
    },
    getCompactionCheckpoint: memory.getCompactionCheckpoint,
    saveCompactionCheckpoint: memory.saveCompactionCheckpoint,
    deleteSession: memory.deleteSession,
  }
  const firstStarted = Promise.withResolvers<void>()
  const releaseFirst = Promise.withResolvers<void>()
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
          firstStarted.resolve()
          await releaseFirst.promise
          yield { type: "finish", reason: "stop" }
        },
      },
      reasoningEffort: "medium",
    }),
    tools: [],
  })

  const run = session.prompt("Initial prompt")
  await run.accepted
  await firstStarted.promise
  session.followUp("Recover this follow-up")
  releaseFirst.resolve()
  const settlementFailure = await run.settled.then(
    () => undefined,
    (error: unknown) => error,
  )

  expect(settlementFailure).toBe(persistenceFailure)
  expect(providerInvocations).toBe(1)
  expect(memory.getMessages("session-1").map((message) => message.role)).toEqual([
    "user",
    "assistant",
  ])
  expect(session.getSnapshot().pendingFollowUpMessages).toEqual([
    expect.objectContaining({
      runId: run.runId,
      source: "followUp",
      content: "Recover this follow-up",
    }),
  ])
  expect(session.clearQueuedMessages()).toEqual({
    steering: [],
    followUp: ["Recover this follow-up"],
  })

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
    getCompactionCheckpoint: memory.getCompactionCheckpoint,
    saveCompactionCheckpoint: memory.saveCompactionCheckpoint,
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
    content: "A durable tool result was not recorded. The tool may have produced side effects; inspect the current state before retrying.",
    isError: true,
    outcome: "effects-unknown" as const,
    summary: "Tool outcome is unknown; inspect state before retrying",
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
    content: "A durable tool result was not recorded. The tool may have produced side effects; inspect the current state before retrying.",
    isError: true,
    outcome: "effects-unknown",
    summary: "Tool outcome is unknown; inspect state before retrying",
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
      content: "A durable tool result was not recorded. The tool may have produced side effects; inspect the current state before retrying.",
      isError: true,
      outcome: "effects-unknown",
      summary: "Tool outcome is unknown; inspect state before retrying",
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

test("AgentSession compacts durable history and projects only summary plus tail", async () => {
  const manager = new InMemorySessionManager()
  manager.createSession(sessionInfo("session-1", "test-agent", "Compaction"))
  seedConversation(manager, 3, "x".repeat(50_000))
  const original = manager.getMessages("session-1")
  const requests: IAgentModelRequest[] = []
  const model: IAgentModel = {
    async *stream(request) {
      requests.push(request)
      if (request.runId.startsWith("compaction-")) {
        yield { type: "text-start", id: "summary" }
        yield { type: "text-delta", id: "summary", delta: "Earlier context" }
        yield { type: "text-end", id: "summary" }
        yield {
          type: "finish",
          reason: "stop",
          usage: { inputTokens: 30, outputTokens: 4, totalTokens: 34 },
        }
        return
      }
      yield { type: "text-start", id: "answer" }
      yield { type: "text-delta", id: "answer", delta: "New answer" }
      yield { type: "text-end", id: "answer" }
      yield {
        type: "finish",
        reason: "stop",
        usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
      }
    },
  }
  let id = 0
  const session = new AgentSession({
    agentId: "test-agent",
    sessionId: "session-1",
    manager,
    systemPrompt: "System",
    resolveRunConfiguration: () => ({
      model,
      modelProfile: {
        providerId: "test",
        modelId: "model-1",
        contextWindowTokens: 100_000,
      },
      reasoningEffort: "medium",
    }),
    tools: [],
    now: () => 100 + id,
    generateId: () => `generated-${++id}`,
  })

  const checkpoint = await session.compact()
  expect(checkpoint).toMatchObject({
    reason: "manual",
    compactedMessageCount: 4,
    throughMessageId: original[3]!.id,
    summary: "Earlier context",
  })
  expect(manager.getMessages("session-1")).toEqual(original)

  const run = session.prompt("Continue")
  await run.settled
  const promptRequest = requests.find(
    (request) => !request.runId.startsWith("compaction-"),
  )
  expect(promptRequest?.contextSummary).toBe("Earlier context")
  expect(promptRequest?.messages.slice(0, -1)).toEqual(original.slice(4))
  expect(manager.getMessages("session-1").slice(0, 6)).toEqual([...original])
  expect(manager.getMessages("session-1").at(-1)).toMatchObject({
    role: "assistant",
    model: {
      providerId: "test",
      modelId: "model-1",
      contextWindowTokens: 100_000,
    },
    usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
  })

  await session.dispose()
})

test("AgentSession does not compact after settlement from reported usage", async () => {
  const manager = new InMemorySessionManager()
  manager.createSession(sessionInfo("session-1", "test-agent", "Automatic"))
  seedConversation(manager, 3)
  let compactionRequests = 0
  const model: IAgentModel = {
    async *stream(request) {
      if (request.runId.startsWith("compaction-")) {
        compactionRequests += 1
        yield { type: "text-start", id: "summary" }
        yield { type: "text-delta", id: "summary", delta: "Auto summary" }
        yield { type: "text-end", id: "summary" }
        yield { type: "finish", reason: "stop" }
        return
      }
      yield { type: "finish", reason: "stop", usage: { totalTokens: 3_500 } }
    },
  }
  const session = new AgentSession({
    agentId: "test-agent",
    sessionId: "session-1",
    manager,
    systemPrompt: "System",
    resolveRunConfiguration: () => ({
      model,
      modelProfile: {
        providerId: "test",
        modelId: "tiny",
        contextWindowTokens: 4_096,
      },
      reasoningEffort: "none",
    }),
    tools: [],
  })

  const run = session.prompt("Trigger automatic compaction")
  await run.settled
  await session.waitForIdle()

  expect(compactionRequests).toBe(0)
  expect(manager.getCompactionCheckpoint("session-1")).toBeUndefined()
  expect(session.getSnapshot().contextUsage).toMatchObject({
    contextWindowTokens: 4_096,
    shouldCompact: false,
  })
  expect(manager.getMessages("session-1")).toHaveLength(8)

  await session.dispose()
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

function seedConversation(
  manager: InMemorySessionManager,
  turns: number,
  padding = "",
): void {
  for (let index = 0; index < turns; index += 1) {
    const runId = `seed-run-${index}`
    manager.appendMessage(userMessage(
      `${padding}Question ${index}`,
      "session-1",
      `seed-user-${index}`,
      runId,
      index * 2 + 1,
    ))
    manager.appendMessage(textAssistantMessage(
      `seed-assistant-${index}`,
      runId,
      `${padding}Answer ${index}`,
      index * 2 + 2,
    ))
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
