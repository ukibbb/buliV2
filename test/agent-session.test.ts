import { expect, test } from "bun:test"

import type {
  IAgentModel,
  IAgentModelRequest,
  IAgentTool,
  IAssistantMessage,
  TToolApprovalDecision,
  IToolResultMessage,
  IUserMessage,
} from "@/agent"
import {
  AgentSession,
  freezeSessionSnapshot,
  InMemorySessionManager,
  type ISessionManager,
  type ISessionSnapshot,
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

test("AgentSession expires durable pending proposals that cannot be reapplied", async () => {
  const manager = new InMemorySessionManager()
  manager.createSession(sessionInfo("session-1", "test-agent", "Restored"))
  manager.saveFileChangeProposal({
    id: "proposal-1",
    sessionId: "session-1",
    runId: "run-1",
    toolCallId: "edit-1",
    operation: "edit",
    path: "src/example.ts",
    diff: "--- a/src/example.ts\n+++ b/src/example.ts\n",
    status: "pending",
    createdAt: 10,
  })

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
    now: () => 20,
  })

  expect(manager.getFileChangeProposals("session-1")).toEqual([{
    id: "proposal-1",
    sessionId: "session-1",
    runId: "run-1",
    toolCallId: "edit-1",
    operation: "edit",
    path: "src/example.ts",
    diff: "--- a/src/example.ts\n+++ b/src/example.ts\n",
    status: "expired",
    createdAt: 10,
    resolvedAt: 20,
  }])
  expect(session.getSnapshot().fileChangeProposals).toEqual(
    manager.getFileChangeProposals("session-1"),
  )
  expect(session.getSnapshot()).not.toHaveProperty(
    "pendingFileChangeProposal",
  )

  await session.dispose()
})

test("AgentSession structurally shares immutable history across streaming snapshots", async () => {
  const manager = new InMemorySessionManager()
  manager.createSession(sessionInfo("session-1", "test-agent", "Streaming"))
  seedConversation(manager, 1)
  const releaseFirstDelta = Promise.withResolvers<void>()
  const releaseSecondDelta = Promise.withResolvers<void>()
  const releaseFinish = Promise.withResolvers<void>()
  type TPublication = {
    snapshot: ISessionSnapshot
    stateMessage: IAssistantMessage | undefined
  }
  const firstDeltaPublished = Promise.withResolvers<TPublication>()
  const secondDeltaPublished = Promise.withResolvers<TPublication>()
  const toolInput = { path: { directory: "src", file: "index.ts" } }
  const model: IAgentModel = {
    async *stream() {
      yield {
        type: "tool-call",
        toolCallId: "read-call",
        toolName: "read-file",
        input: toolInput,
      }
      yield { type: "text-start", id: "answer" }
      await releaseFirstDelta.promise
      yield { type: "text-delta", id: "answer", delta: "First" }
      await releaseSecondDelta.promise
      yield { type: "text-delta", id: "answer", delta: " second" }
      await releaseFinish.promise
      yield { type: "finish", reason: "error" }
    },
  }
  const session = new AgentSession({
    agentId: "test-agent",
    sessionId: "session-1",
    manager,
    systemPrompt: "System",
    resolveRunConfiguration: () => ({ model, reasoningEffort: "medium" }),
    tools: [],
  })
  session.subscribe(() => {
    const snapshot = session.getSnapshot()
    const text = streamingText(snapshot)
    const publication = {
      snapshot,
      stateMessage: session.state.streamingMessage,
    }
    if (text === "First") firstDeltaPublished.resolve(publication)
    if (text === "First second") secondDeltaPublished.resolve(publication)
  })

  const run = session.prompt("Continue")
  await run.accepted
  releaseFirstDelta.resolve()
  const firstPublication = await firstDeltaPublished.promise
  const first = firstPublication.snapshot
  releaseSecondDelta.resolve()
  const secondPublication = await secondDeltaPublished.promise
  const second = secondPublication.snapshot

  expect(second).not.toBe(first)
  expect(second.streamingMessage).not.toBe(first.streamingMessage)
  expect(first.streamingMessage).toBe(firstPublication.stateMessage)
  expect(second.streamingMessage).toBe(secondPublication.stateMessage)
  expect(second.messages).toBe(first.messages)
  expect(second.pendingToolCallIds).toBe(first.pendingToolCallIds)
  expect(second.contextUsage).toBe(first.contextUsage)
  expect(second.messages).toHaveLength(3)
  expect(streamingText(first)).toBe("First")
  expect(streamingText(second)).toBe("First second")
  expect(Object.isFrozen(second)).toBe(true)
  expect(Object.isFrozen(second.messages)).toBe(true)
  expect(Object.isFrozen(second.messages[0])).toBe(true)
  expect(Object.isFrozen(second.messages[1])).toBe(true)
  expect(Object.isFrozen(second.contextUsage)).toBe(true)
  const completedAssistant = second.messages[1]
  if (completedAssistant?.role !== "assistant") {
    throw new Error("Expected completed assistant history")
  }
  expect(Object.isFrozen(completedAssistant.content)).toBe(true)
  expect(Object.isFrozen(completedAssistant.content[0])).toBe(true)
  expect(Object.isFrozen(second.streamingMessage)).toBe(true)
  expect(Object.isFrozen(second.streamingMessage?.content)).toBe(true)
  expect(second.streamingMessage?.content.every(Object.isFrozen)).toBe(true)
  expect(() => (second.messages as unknown[]).push({})).toThrow()
  const streamedText = second.streamingMessage?.content.find(
    (item) => item.type === "text",
  )
  expect(() => {
    if (streamedText?.type === "text") {
      (streamedText as { text: string }).text = "Changed"
    }
  }).toThrow()

  const toolCall = first.streamingMessage?.content.find(
    (item) => item.type === "toolCall",
  )
  if (!toolCall) throw new Error("Expected a streaming tool call")
  toolInput.path.file = "changed.ts"

  expect(streamingText(first)).toBe("First")
  expect(streamingText(second)).toBe("First second")
  expect(toolCall.input).toEqual({
    path: { directory: "src", file: "index.ts" },
  })
  expect(Object.isFrozen(toolCall)).toBe(true)
  expect(Object.isFrozen(toolCall.input)).toBe(true)
  expect(Object.isFrozen(toolCall.input.path)).toBe(true)
  expect(() => {
    (toolCall.input.path as { file: string }).file = "mutated.ts"
  }).toThrow()

  releaseFinish.resolve()
  await run.settled
  const settled = session.getSnapshot()
  expect(streamingText(first)).toBe("First")
  expect(streamingText(second)).toBe("First second")
  expect(toolCall.input).toEqual({
    path: { directory: "src", file: "index.ts" },
  })
  expect(settled.messages).not.toBe(second.messages)
  expect(Object.isFrozen(settled.messages)).toBe(true)
  expect(Object.isFrozen(settled.messages.at(-1))).toBe(true)

  await session.dispose()

  function streamingText(snapshot: ISessionSnapshot): string | undefined {
    return snapshot.streamingMessage?.content.find(
      (item) => item.type === "text",
    )?.text
  }
})

test("freezeSessionSnapshot freezes and structurally shares checkpoints", () => {
  const checkpoint = {
    id: "checkpoint-1",
    sessionId: "session-1",
    createdAt: 10,
    reason: "automatic" as const,
    compactedMessageCount: 2,
    throughMessageId: "seed-assistant-0",
    summary: "Preserved context",
    model: {
      providerId: "test",
      modelId: "model-1",
      contextWindowTokens: 100_000,
    },
    usage: { inputTokens: 30, outputTokens: 4, totalTokens: 34 },
  }
  const cache = {
    source: undefined,
    value: undefined,
  }
  const source = sessionSnapshotWithCheckpoint(checkpoint)

  const first = freezeSessionSnapshot(source, cache)
  const second = freezeSessionSnapshot({ ...source, isRunning: true }, cache)

  expect(second).not.toBe(first)
  expect(second.compactionCheckpoint).toBe(first.compactionCheckpoint)
  expect(Object.isFrozen(first.compactionCheckpoint)).toBe(true)
  expect(Object.isFrozen(first.compactionCheckpoint?.model)).toBe(true)
  expect(Object.isFrozen(first.compactionCheckpoint?.usage)).toBe(true)
  checkpoint.model.modelId = "mutated-model"
  checkpoint.usage.totalTokens = 999
  expect(first.compactionCheckpoint?.model?.modelId).toBe("model-1")
  expect(first.compactionCheckpoint?.usage?.totalTokens).toBe(34)
  expect(() => {
    if (first.compactionCheckpoint?.model) {
      (first.compactionCheckpoint.model as { modelId: string }).modelId =
        "changed"
    }
  }).toThrow()

  const replacementCheckpoint = {
    ...checkpoint,
    id: "checkpoint-2",
    summary: "Latest preserved context",
  }
  const third = freezeSessionSnapshot(
    sessionSnapshotWithCheckpoint(replacementCheckpoint),
    cache,
  )
  expect(third.compactionCheckpoint).not.toBe(second.compactionCheckpoint)
  expect(third.compactionCheckpoint?.summary).toBe("Latest preserved context")
  expect(Object.isFrozen(third.compactionCheckpoint)).toBe(true)
})

test("AgentSession publishes immutable approval request and resolution snapshots", async () => {
  const manager = new InMemorySessionManager()
  manager.createSession(sessionInfo("session-1", "test-agent", "Approval"))
  const approvalStarted = Promise.withResolvers<void>()
  const decisions: TToolApprovalDecision[] = []
  const tool: IAgentTool = {
    name: "bash",
    approvalKind: "command",
    description: "Run a command",
    inputSchema: { type: "object", additionalProperties: false },
    async execute(_input, context) {
      if (!context.requestApproval) throw new Error("Missing approval bridge")
      const decisionTask = context.requestApproval({
        kind: "command",
        title: "Verify the runtime",
        explanation: "Run the focused runtime tests",
        command: "bun test test/runtime.test.ts",
        cwd: "/workspace",
        purpose: "Verify the runtime behavior",
        expectedOutcome: "The runtime tests pass",
        sideEffects: "May write temporary test caches",
        timeoutSeconds: 30,
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
              toolCallId: "command-call",
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

  const run = session.prompt("Run the runtime tests")
  await approvalStarted.promise
  const waitingSnapshot = session.getSnapshot()
  const request = waitingSnapshot.pendingToolApproval
  if (!request) {
    throw new Error("Expected pending command approval")
  }

  expect(request).toMatchObject({
    sessionId: "session-1",
    runId: run.runId,
    toolCallId: "command-call",
    kind: "command",
    command: "bun test test/runtime.test.ts",
    cwd: "/workspace",
    timeoutSeconds: 30,
  })
  expect(Object.isFrozen(waitingSnapshot)).toBe(true)
  expect(Object.isFrozen(request)).toBe(true)
  expect(() => {
    (request as { command: string }).command = "bun test"
  }).toThrow()
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
    getFileChangeProposals: memory.getFileChangeProposals,
    saveFileChangeProposal: memory.saveFileChangeProposal,
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
    getFileChangeProposals: memory.getFileChangeProposals,
    saveFileChangeProposal: memory.saveFileChangeProposal,
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
    getFileChangeProposals: memory.getFileChangeProposals,
    saveFileChangeProposal: memory.saveFileChangeProposal,
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

test("AgentSession does not persist a manual checkpoint that enlarges context", async () => {
  const manager = new InMemorySessionManager()
  manager.createSession(sessionInfo("session-1", "test-agent", "No progress"))
  seedConversation(manager, 1)
  const original = manager.getMessages("session-1")
  const session = new AgentSession({
    agentId: "test-agent",
    sessionId: "session-1",
    manager,
    systemPrompt: "System",
    resolveRunConfiguration: () => ({
      model: {
        async *stream() {
          yield {
            type: "text-delta",
            id: "summary",
            delta: structuredSummary("X".repeat(5_000)),
          }
          yield { type: "finish", reason: "stop" }
        },
      },
      reasoningEffort: "medium",
    }),
    tools: [],
  })

  expect(await session.compact()).toBeUndefined()
  expect(manager.getCompactionCheckpoint("session-1")).toBeUndefined()
  expect(manager.getMessages("session-1")).toEqual(original)

  await session.dispose()
})

test("AgentSession compacts durable history into one cumulative checkpoint", async () => {
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
        yield {
          type: "text-delta",
          id: "summary",
          delta: structuredSummary("Earlier context"),
        }
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
        contextWindowTokens: 272_000,
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
    compactedMessageCount: 6,
    throughMessageId: original[5]!.id,
    summary: structuredSummary("Earlier context"),
  })
  expect(manager.getMessages("session-1")).toEqual(original)
  expect(await session.compact()).toBeUndefined()

  const run = session.prompt("Continue")
  await run.settled
  const promptRequest = requests.find(
    (request) => !request.runId.startsWith("compaction-"),
  )
  expect(promptRequest?.contextSummary).toBe(structuredSummary("Earlier context"))
  expect(promptRequest?.messages.slice(0, -1)).toEqual(original.slice(6))
  expect(manager.getMessages("session-1").slice(0, 6)).toEqual([...original])
  expect(manager.getMessages("session-1").at(-1)).toMatchObject({
    role: "assistant",
    model: {
      providerId: "test",
      modelId: "model-1",
      contextWindowTokens: 272_000,
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
        yield {
          type: "text-delta",
          id: "summary",
          delta: structuredSummary("Auto summary"),
        }
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

function sessionSnapshotWithCheckpoint(
  compactionCheckpoint: NonNullable<ISessionSnapshot["compactionCheckpoint"]>,
): ISessionSnapshot {
  return {
    messages: [],
    fileChangeProposals: [],
    pendingSteeringMessages: [],
    pendingFollowUpMessages: [],
    compactionCheckpoint,
    isRunning: false,
    isCompacting: false,
    pendingToolCallIds: [],
  }
}

function sessionInfo(id: string, agentId: string, title: string) {
  return {
    id,
    agentId,
    title,
    createdAt: 1,
    updatedAt: 1,
  }
}

function structuredSummary(label: string): string {
  return `## Goals
- ${label}

## User Constraints
- (none)

## Active Request
- ${label}

## Files Read and Why
- (none)

## Modifications
- (none)

## Commands and Tests
- (none)

## Decisions
- (none)

## Current State
- ${label}

## Next Steps
1. Continue

## Handoff Guidance
- Reread reproducible data when exact details are needed.`
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
