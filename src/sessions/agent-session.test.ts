import { expect, spyOn, test } from "bun:test"

import {
  type IAgentModel,
  type IAgentModelRequest,
  type IAssistantMessage,
  type IToolResultMessage,
  type IUserMessage,
} from "@/agent"
import {
  AgentSession,
  freezeSessionSnapshot,
  SQLiteSessionManager,
  type ISessionManager,
  type ISessionSnapshot,
} from "@/sessions"

test("AgentSession restores history, persists completion barriers, and publishes stable snapshots", async () => {
  const manager = new SQLiteSessionManager({ databasePath: ":memory:" })
  manager.createSession(sessionInfo("session-1", "test-agent", "Restored"))
  manager.appendMessage(userMessage("Restored"))
  const persistedBeforeModel: number[] = []
  const model: IAgentModel = {
    async *stream() {
      persistedBeforeModel.push(manager.loadRequiredContext("session-1").messages.length)
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
  await run.initialPromptProcessed
  await run.runFinished

  expect(persistedBeforeModel).toEqual([2])
  expect(manager.loadRequiredContext("session-1").messages).toHaveLength(3)
  expect(session.getSnapshot()).not.toBe(initial)
  expect(session.getSnapshot()).toBe(session.getSnapshot())
  expect(session.loadHistoryPage("main").messages.map((message) => message.role)).toEqual([
    "user",
    "user",
    "assistant",
  ])
  expect(session.loadHistoryPage("main").messages.slice(1).every((message) =>
    message.runId === run.runId
  )).toBe(true)
  expect(session.getSnapshot().isRunning).toBe(false)
  expect(notifications).toBeGreaterThan(0)

  await session.dispose()
})

test.each([false, true])("AgentSession structurally shares immutable streaming branches (populated: %s)", async (populated) => {
  const manager = new SQLiteSessionManager({ databasePath: ":memory:" })
  manager.createSession(sessionInfo("session-1", "test-agent", "Streaming"))
  seedConversation(manager, 1)
  const checkpoint = compactionCheckpoint()
  manager.saveCompactionCheckpoint(checkpoint)
  const releaseFirstDelta = Promise.withResolvers<void>()
  const releaseSecondDelta = Promise.withResolvers<void>()
  const releaseFinish = Promise.withResolvers<void>()
  const firstDeltaPublished = Promise.withResolvers<void>()
  const secondDeltaPublished = Promise.withResolvers<void>()
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
      // Resuming after yield acknowledges processing without timers or polling.
      firstDeltaPublished.resolve()
      await releaseSecondDelta.promise
      yield { type: "text-delta", id: "answer", delta: " second" }
      secondDeltaPublished.resolve()
      await releaseFinish.promise
      yield { type: "finish", reason: "error" }
    },
  }
  const contextReads = spyOn(manager, "loadRequiredContext")
  const session = new AgentSession({
    agentId: "test-agent",
    sessionId: "session-1",
    manager,
    systemPrompt: "System",
    resolveRunConfiguration: () => ({ model, reasoningEffort: "medium" }),
    tools: [],
  })
  const initial = session.getSnapshot()
  let publication = {
    snapshot: initial,
    stateMessage: session.state.streamingMessage,
  }
  session.subscribe(() => {
    publication = {
      snapshot: session.getSnapshot(),
      stateMessage: session.state.streamingMessage,
    }
  })

  try {
    const run = session.prompt("Continue")
    await run.initialPromptProcessed
    if (populated) {
      session.steer("Adjust the answer")
      session.followUp("Then summarize it")
    }
    releaseFirstDelta.resolve()
    await Promise.race([firstDeltaPublished.promise, run.runFinished])
    const firstPublication = publication
    const first = firstPublication.snapshot
    const firstValue = structuredClone(first)
    const readsBeforeDelta = contextReads.mock.calls.length
    expect(readsBeforeDelta).toBeGreaterThan(0)
    releaseSecondDelta.resolve()
    await Promise.race([secondDeltaPublished.promise, run.runFinished])
    const secondPublication = publication
    const second = secondPublication.snapshot
    const secondValue = structuredClone(second)

    expect(second).not.toBe(first)
    expect(second.streamingMessage).not.toBe(first.streamingMessage)
    expect(first.streamingMessage).toBe(firstPublication.stateMessage)
    expect(second.streamingMessage).toBe(secondPublication.stateMessage)
    expect(second).not.toHaveProperty("messages")
    expect(second.pendingToolCallIds).toBe(first.pendingToolCallIds)
    expect(second.contextUsage).toBe(first.contextUsage)
    // Equal-but-recloned branches still invalidate UI history/queue memoization.
    expect(contextReads.mock.calls.length).toBe(readsBeforeDelta)
    for (const branch of [
      "pendingSteeringMessages",
      "pendingFollowUpMessages",
    ] as const) {
      expect(second[branch]).toBe(first[branch])
      expect(Object.isFrozen(second[branch])).toBe(true)
    }
    for (const items of [
      first.pendingSteeringMessages,
      first.pendingFollowUpMessages,
    ]) {
      expect(items).toHaveLength(populated ? 1 : 0)
      expect(items.every(Object.isFrozen)).toBe(true)
      expect(() => (items as unknown[]).push({})).toThrow()
    }
    expect(session.loadHistoryPage("main").messages).toHaveLength(3)
    expect(streamingText(first)).toBe("First")
    expect(streamingText(second)).toBe("First second")
    expect(Object.isFrozen(second)).toBe(true)
    expect(Object.isFrozen(second.contextUsage)).toBe(true)
    expect(Object.isFrozen(second.streamingMessage)).toBe(true)
    expect(Object.isFrozen(second.streamingMessage?.content)).toBe(true)
    expect(second.streamingMessage?.content.every(Object.isFrozen)).toBe(true)
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
    await run.runFinished
    const settled = session.getSnapshot()
    expect(streamingText(first)).toBe("First")
    expect(streamingText(second)).toBe("First second")
    expect(toolCall.input).toEqual({
      path: { directory: "src", file: "index.ts" },
    })
    expect(settled).not.toHaveProperty("messages")
    expect(session.loadHistoryPage("main").messages).toHaveLength(4)

    expect(session.clearQueuedMessages()).toEqual({
      steering: populated ? ["Adjust the answer"] : [],
      followUp: populated ? ["Then summarize it"] : [],
    })
    const cleared = session.getSnapshot()
    expect(cleared.pendingSteeringMessages).toEqual([])
    expect(cleared.pendingFollowUpMessages).toEqual([])
    if (populated) {
      expect(cleared.pendingSteeringMessages).not.toBe(second.pendingSteeringMessages)
      expect(cleared.pendingFollowUpMessages).not.toBe(second.pendingFollowUpMessages)
    } else {
      expect(cleared).toBe(settled)
    }
    expect(first).toEqual(firstValue)
    expect(second).toEqual(secondValue)
    expect(initial.pendingSteeringMessages).toEqual([])
    expect(initial.pendingFollowUpMessages).toEqual([])
  } finally {
    releaseFirstDelta.resolve()
    releaseSecondDelta.resolve()
    releaseFinish.resolve()
    contextReads.mockRestore()
    await session.dispose()
  }

  function streamingText(snapshot: ISessionSnapshot): string | undefined {
    return snapshot.streamingMessage?.content.find(
      (item) => item.type === "text",
    )?.text
  }
})

test("AgentSession exposes immutable checkpoint records through page reads, not operational snapshots", async () => {
  const manager = new SQLiteSessionManager({ databasePath: ":memory:" })
  manager.createSession(sessionInfo("session-1", "test-agent", "Checkpoint"))
  seedConversation(manager, 1)
  const checkpoint = compactionCheckpoint()
  manager.saveCompactionCheckpoint(checkpoint)
  const session = openAgentSession(manager)
  try {
    const first = session.loadHistoryPage("main")
    expect(first.checkpoint).toEqual(checkpoint)
    expect(session.getSnapshot()).not.toHaveProperty("compactionCheckpoint")
    expect(session.getSnapshot()).not.toHaveProperty("fileChangeProposals")
    expect(session.getSnapshot()).not.toHaveProperty("messages")
    expect(() => manager.saveCompactionCheckpoint({ ...checkpoint, summary: "Changed" })).toThrow()
    expect(session.loadHistoryPage("main").checkpoint).toEqual(checkpoint)
    expect(first.checkpoint).toEqual(checkpoint)
  } finally {
    await session.dispose()
    manager.dispose()
  }
})

test("freezeSessionSnapshot detaches, freezes and shares compaction progress", () => {
  const progress = { id: "candidate", throughMessageId: "anchor", summary: "First" }
  const source = {
    ...operationalSnapshot(),
    compactionProgress: progress,
  }
  const cache = { source: undefined, value: undefined }
  const first = freezeSessionSnapshot(source, cache)
  const second = freezeSessionSnapshot({ ...source, isCompacting: true }, cache)

  expect(first.compactionProgress).not.toBe(progress)
  expect(Object.isFrozen(first.compactionProgress)).toBe(true)
  expect(second.compactionProgress).toBe(first.compactionProgress)
  progress.summary = "Mutated source"
  expect(first.compactionProgress?.summary).toBe("First")
  expect(() => {
    (first.compactionProgress as { summary: string }).summary = "Mutated snapshot"
  }).toThrow()
  const third = freezeSessionSnapshot({
    ...source,
    compactionProgress: { ...progress, summary: "First second" },
  }, cache)
  expect(third.compactionProgress).not.toBe(first.compactionProgress)
  expect(third.compactionProgress?.summary).toBe("First second")
  expect(third.pendingSteeringMessages).toBe(first.pendingSteeringMessages)
  const cleared = freezeSessionSnapshot(operationalSnapshot(), cache)
  expect(cleared).not.toHaveProperty("compactionProgress")
  expect(third.compactionProgress?.summary).toBe("First second")
})

test("AgentSession persists steering and follow-up before each model request", async () => {
  const manager = new SQLiteSessionManager({ databasePath: ":memory:" })
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
      persistedBeforeRequest.push(manager.loadRequiredContext("session-1").messages.length)
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
  await run.initialPromptProcessed
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
  await run.runFinished

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
  expect(manager.loadRequiredContext("session-1").messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "user",
    "assistant",
    "user",
    "assistant",
  ])
  expect(manager.loadRequiredContext("session-1").messages[2]).toMatchObject({
    runId: run.runId,
    source: "steer",
    content: "Adjust the answer",
  })
  expect(manager.loadRequiredContext("session-1").messages[4]).toMatchObject({
    runId: run.runId,
    source: "followUp",
    content: "Then summarize it",
  })
  expect(session.getSnapshot().pendingSteeringMessages).toEqual([])
  expect(session.getSnapshot().pendingFollowUpMessages).toEqual([])

  await session.dispose()
})

test("AgentSession restores steering to the queue when persistence fails", async () => {
  const memory = new SQLiteSessionManager({ databasePath: ":memory:" })
  memory.createSession(sessionInfo("session-1", "test-agent", "Steering failure"))
  const persistenceFailure = new Error("Failed to persist steering")
  const manager: ISessionManager = {
    createSession: memory.createSession,
    getActiveBranchId: memory.getActiveBranchId,
    createBranch: memory.createBranch,
    returnToParentBranch: memory.returnToParentBranch,
    getSessionInfo: memory.getSessionInfo,
    listSessions: memory.listSessions,
    openSession: memory.openSession,
    releaseSession: memory.releaseSession,
    dispose: memory.dispose,
    recoverInterruptedTools: memory.recoverInterruptedTools,
    loadRequiredContext: memory.loadRequiredContext,
    loadRecentConversation: memory.loadRecentConversation,
    loadSelectedPaths: memory.loadSelectedPaths,
    loadHistoryPage: memory.loadHistoryPage,
    deleteEmptySession: memory.deleteEmptySession,
    appendMessage: (message) => {
      if (message.role === "user" && message.source === "steer") {
        throw persistenceFailure
      }
      return memory.appendMessage(message)
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
  await run.initialPromptProcessed
  await firstStarted.promise
  session.steer("Recover this steering")
  releaseFirst.resolve()
  const runFailure = await run.runFinished.then(
    () => undefined,
    (error: unknown) => error,
  )

  expect(runFailure).toBe(persistenceFailure)
  expect(providerInvocations).toBe(1)
  expect(memory.loadRequiredContext("session-1").messages.map((message) => message.role)).toEqual([
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
  const memory = new SQLiteSessionManager({ databasePath: ":memory:" })
  memory.createSession(sessionInfo("session-1", "test-agent", "Follow-up failure"))
  const persistenceFailure = new Error("Failed to persist follow-up")
  const manager: ISessionManager = {
    createSession: memory.createSession,
    getActiveBranchId: memory.getActiveBranchId,
    createBranch: memory.createBranch,
    returnToParentBranch: memory.returnToParentBranch,
    getSessionInfo: memory.getSessionInfo,
    listSessions: memory.listSessions,
    openSession: memory.openSession,
    releaseSession: memory.releaseSession,
    dispose: memory.dispose,
    recoverInterruptedTools: memory.recoverInterruptedTools,
    loadRequiredContext: memory.loadRequiredContext,
    loadRecentConversation: memory.loadRecentConversation,
    loadSelectedPaths: memory.loadSelectedPaths,
    loadHistoryPage: memory.loadHistoryPage,
    deleteEmptySession: memory.deleteEmptySession,
    appendMessage: (message) => {
      if (message.role === "user" && message.source === "followUp") {
        throw persistenceFailure
      }
      return memory.appendMessage(message)
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
  await run.initialPromptProcessed
  await firstStarted.promise
  session.followUp("Recover this follow-up")
  releaseFirst.resolve()
  const runFailure = await run.runFinished.then(
    () => undefined,
    (error: unknown) => error,
  )

  expect(runFailure).toBe(persistenceFailure)
  expect(providerInvocations).toBe(1)
  expect(memory.loadRequiredContext("session-1").messages.map((message) => message.role)).toEqual([
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
  const memory = new SQLiteSessionManager({ databasePath: ":memory:" })
  memory.createSession(sessionInfo("session-1", "test-agent", "Failure"))
  const persistenceFailure = new Error("Disk write failed")
  const manager: ISessionManager = {
    createSession: memory.createSession,
    getActiveBranchId: memory.getActiveBranchId,
    createBranch: memory.createBranch,
    returnToParentBranch: memory.returnToParentBranch,
    getSessionInfo: memory.getSessionInfo,
    listSessions: memory.listSessions,
    openSession: memory.openSession,
    releaseSession: memory.releaseSession,
    dispose: memory.dispose,
    recoverInterruptedTools: memory.recoverInterruptedTools,
    loadRequiredContext: memory.loadRequiredContext,
    loadRecentConversation: memory.loadRecentConversation,
    loadSelectedPaths: memory.loadSelectedPaths,
    loadHistoryPage: memory.loadHistoryPage,
    deleteEmptySession: memory.deleteEmptySession,
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
  const initialPromptProcessingFailure = run.initialPromptProcessed.then(
    () => undefined,
    (error: unknown) => error,
  )
  const runFailure = run.runFinished.then(
    () => undefined,
    (error: unknown) => error,
  )

  expect(await initialPromptProcessingFailure).toBe(persistenceFailure)
  expect(await runFailure).toBe(persistenceFailure)

  expect(providerInvocations).toBe(0)
  expect(session.loadHistoryPage("main").messages).toEqual(
    manager.loadRequiredContext("session-1").messages,
  )
  expect(session.getSnapshot().isRunning).toBe(false)

  await session.dispose()
})

for (const committed of [false, true]) {
  for (const failure of [new Error("Durable acceptance failed"), undefined]) {
    test(`AgentSession retains the failure barrier after settlement: committed=${committed}, cause=${String(failure)}`, async () => {
      const manager = new SQLiteSessionManager({ databasePath: ":memory:" })
      manager.createSession(sessionInfo("session-1", "test-agent", "Failure barrier"))
      let providerInvocations = 0
      const options = {
        agentId: "test-agent",
        sessionId: "session-1",
        manager,
        systemPrompt: "System",
        resolveRunConfiguration: () => ({
          model: {
            async *stream() {
              providerInvocations += 1
              yield { type: "finish" as const, reason: "stop" as const }
            },
          },
          reasoningEffort: "medium" as const,
        }),
        tools: [],
      }
      const session = new AgentSession(options)
      const appendMessage = manager.appendMessage
      const append = spyOn(manager, "appendMessage").mockImplementation((message) => {
        if (committed) appendMessage(message)
        throw failure
      })
      try {
        const run = session.prompt("Preserve this committed prompt")
        const results = await Promise.allSettled([
          run.initialPromptProcessed,
          run.runFinished,
        ])
        expect(results).toEqual([
          { status: "rejected", reason: failure },
          { status: "rejected", reason: failure },
        ])
        expect(providerInvocations).toBe(0)
        expect(append).toHaveBeenCalledTimes(1)
        expect(manager.loadRequiredContext("session-1").messages).toHaveLength(committed ? 1 : 0)
        expect(session.loadHistoryPage("main").messages).toEqual(manager.loadRequiredContext("session-1").messages)
        expect(session.getSnapshot().isRunning).toBe(false)

        // A successful presentation reload must not authorize another model request.
        const interactions = [
          () => session.prompt("Must not run"),
          () => session.steer("Must not queue"),
          () => session.followUp("Must not queue"),
          () => session.compact(),
          () => session.createBranch(),
          () => session.assertCanUpdateConfiguration(),
        ]
        for (const interact of interactions) {
          expect(interact).toThrow("Session persistence failed. Reopen the session")
        }
        let nextPromptFailure: unknown
        try {
          session.prompt("Still blocked")
        } catch (error) {
          nextPromptFailure = error
        }
        expect(nextPromptFailure).toBeInstanceOf(Error)
        expect((nextPromptFailure as Error).cause).toBe(failure)
        expect(append).toHaveBeenCalledTimes(1)
        expect(providerInvocations).toBe(0)
      } finally {
        append.mockRestore()
        await session.dispose()
      }

      // Reopening reconstructs durable state instead of reusing the failed live session.
      const reopened = new AgentSession(options)
      try {
        expect(reopened.loadHistoryPage("main").messages).toHaveLength(committed ? 1 : 0)
        await reopened.prompt("Continue after reopening").runFinished
        expect(providerInvocations).toBe(1)
        expect(manager.loadRequiredContext("session-1").messages).toHaveLength(committed ? 3 : 2)
      } finally {
        await reopened.dispose()
      }
    })
  }
}

test("AgentSession recovers one interrupted tool call deterministically without duplicating it on reopen", async () => {
  const manager = new SQLiteSessionManager({ databasePath: ":memory:" })
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
    assistantMessageId: assistant.id,
    toolCallId: "call-read",
    toolName: "read_file",
    content: "A durable tool result was not recorded. The tool may have produced side effects; inspect the current state before retrying.",
    isError: true,
    outcome: "effects-unknown" as const,
    summary: "Tool outcome is unknown; inspect state before retrying",
    createdAt: 2,
  }

  const first = openAgentSession(manager)

  expect(manager.loadRequiredContext("session-1").messages).toEqual([user, assistant, recovery])
  expect(first.loadHistoryPage("main").messages).toEqual([user, assistant, recovery])
  await first.dispose()

  const reopened = openAgentSession(manager)

  expect(manager.loadRequiredContext("session-1").messages).toEqual([user, assistant, recovery])
  expect(reopened.loadHistoryPage("main").messages).toEqual([user, assistant, recovery])
  expect(manager.loadRequiredContext("session-1").messages.filter((message) =>
    message.role === "toolResult" && message.toolCallId === "call-read"
  )).toHaveLength(1)

  await reopened.dispose()
})

test("AgentSession recovers a toolCallId reused by a later run", async () => {
  const manager = new SQLiteSessionManager({ databasePath: ":memory:" })
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
    assistantMessageId: firstAssistant.id,
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

  expect(manager.loadRequiredContext("session-1").messages.at(-1)).toEqual({
    id: "recovered-assistant-run-2-call-shared",
    sessionId: "session-1",
    runId: "run-2",
    role: "toolResult",
    assistantMessageId: secondAssistant.id,
    toolCallId: "call-shared",
    toolName: "read_file",
    content: "A durable tool result was not recorded. The tool may have produced side effects; inspect the current state before retrying.",
    isError: true,
    outcome: "effects-unknown",
    summary: "Tool outcome is unknown; inspect state before retrying",
    createdAt: 5,
  })
  expect(manager.loadRequiredContext("session-1").messages.filter((message) =>
    message.role === "toolResult" && message.toolCallId === "call-shared"
  ).map((message) => message.runId)).toEqual(["run-1", "run-2"])
  expect(session.loadHistoryPage("main").messages).toEqual(
    manager.loadRequiredContext("session-1").messages,
  )

  await session.dispose()
})

test("AgentSession rejects an interrupted tool turn followed by a later message", () => {
  const laterMessages = [
    userMessage("Later user", "session-1", "later-user", "run-2", 3),
    textAssistantMessage("later-assistant", "run-2", "Later answer", 3),
  ]

  for (const laterMessage of laterMessages) {
    const manager = new SQLiteSessionManager({ databasePath: ":memory:" })
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
    const durableBeforeOpen = manager.loadRequiredContext("session-1").messages

    expect(() => manager.appendMessage(laterMessage)).toThrow()
    expect(manager.loadRequiredContext("session-1").messages).toEqual(durableBeforeOpen)
    expect(manager.loadRequiredContext("session-1").messages.some((message) =>
      message.role === "toolResult"
    )).toBe(false)
  }
})

test("AgentSession suffixes a colliding recovery ID without replacing history", async () => {
  const manager = new SQLiteSessionManager({ databasePath: ":memory:" })
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

  expect(manager.loadRequiredContext("session-1").messages).toEqual([
    existing,
    assistant,
    {
      id: `${collidingId}-1`,
      sessionId: "session-1",
      runId: "run-interrupted",
      role: "toolResult",
      assistantMessageId: assistant.id,
      toolCallId: "call-read",
      toolName: "read_file",
      content: "A durable tool result was not recorded. The tool may have produced side effects; inspect the current state before retrying.",
      isError: true,
      outcome: "effects-unknown",
      summary: "Tool outcome is unknown; inspect state before retrying",
      createdAt: 2,
    },
  ])
  expect(manager.loadRequiredContext("session-1").messages[0]).toEqual(existing)
  expect(session.loadHistoryPage("main").messages).toEqual(
    manager.loadRequiredContext("session-1").messages,
  )

  await session.dispose()
})

test("AgentSession dispose times out and unsubscribes from a non-cooperative model", async () => {
  const manager = new SQLiteSessionManager({ databasePath: ":memory:" })
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
  const runFailure = run.runFinished.then(
    () => undefined,
    (error: unknown) => error,
  )
  await run.initialPromptProcessed
  await modelStarted.promise
  const notificationsBeforeDispose = notifications
  let lateNotifications = 0
  const disposal = session.dispose()

  try {
    const unsubscribeDuringDisposal = session.subscribe(() => {
      lateNotifications += 1
    })
    expect(unsubscribeDuringDisposal).not.toThrow()
    await expect(disposal).rejects.toThrow(
      "Timed out waiting for AgentSession to stop",
    )
    const unsubscribeAfterTimeout = session.subscribe(() => {
      lateNotifications += 1
    })
    expect(unsubscribeAfterTimeout).not.toThrow()
  } finally {
    releaseModel.resolve()
  }

  expect(await runFailure).toEqual(
    new Error("AgentSession stopped accepting events during shutdown"),
  )
  expect(notifications).toBe(notificationsBeforeDispose)
  expect(lateNotifications).toBe(0)
  expect(unsubscribe).not.toThrow()
})

test("AgentSession does not persist a manual checkpoint that enlarges context", async () => {
  const manager = new SQLiteSessionManager({ databasePath: ":memory:" })
  manager.createSession(sessionInfo("session-1", "test-agent", "No progress"))
  seedConversation(manager, 1)
  const original = manager.loadRequiredContext("session-1").messages
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
  expect(session.loadHistoryPage("main").messages).toEqual(original)

  await session.dispose()
})

test.each([false, true])("AgentSession streams immutable compaction progress and installs it atomically (previous: %s)", async (hasPrevious) => {
  const manager = new SQLiteSessionManager({ databasePath: ":memory:" })
  manager.createSession(sessionInfo("session-1", "test-agent", "Progress"))
  seedConversation(manager, 2, "X".repeat(1_000))
  if (hasPrevious) manager.saveCompactionCheckpoint(compactionCheckpoint())
  const saves = spyOn(manager, "saveCompactionCheckpoint")
  const contextReads = spyOn(manager, "loadRequiredContext")
  const firstPublished = Promise.withResolvers<void>()
  const secondPublished = Promise.withResolvers<void>()
  const releaseSecond = Promise.withResolvers<void>()
  const releaseFinish = Promise.withResolvers<void>()
  const session = new AgentSession({
    agentId: "test-agent",
    sessionId: "session-1",
    manager,
    systemPrompt: "System",
    resolveRunConfiguration: () => ({
      model: {
        async *stream() {
          yield { type: "text-delta", id: "summary", delta: "## Goals\n\nFirst" }
          firstPublished.resolve()
          await releaseSecond.promise
          yield { type: "text-delta", id: "summary", delta: " second" }
          secondPublished.resolve()
          await releaseFinish.promise
          yield { type: "finish", reason: "stop" }
        },
      },
      reasoningEffort: "medium",
    }),
    tools: [],
    generateId: () => "candidate",
  })
  const initial = session.getSnapshot()
  const publications: ISessionSnapshot[] = []
  session.subscribe(() => publications.push(session.getSnapshot()))
  const task = session.compact()

  try {
    expect(session.getSnapshot().isCompacting).toBe(true)
    expect(session.getSnapshot().compactionProgress).toBeUndefined()
    await Promise.race([firstPublished.promise, task])
    const first = session.getSnapshot()
    const readsBefore = contextReads.mock.calls.length
    expect(first.compactionProgress).toEqual({
      id: "candidate", throughMessageId: "seed-assistant-1", summary: "## Goals\n\nFirst",
    })
    expect(Object.isFrozen(first.compactionProgress)).toBe(true)
    expect(first.streamingMessage).toBeUndefined()
    expect(saves).not.toHaveBeenCalled()
    expect(session.loadHistoryPage("main").checkpoint).toEqual(hasPrevious ? compactionCheckpoint() : undefined)
    releaseSecond.resolve()
    await Promise.race([secondPublished.promise, task])
    const second = session.getSnapshot()
    expect(second.compactionProgress?.summary).toBe("## Goals\n\nFirst second")
    expect(first.compactionProgress?.summary).toBe("## Goals\n\nFirst")
    expect(second.compactionProgress).not.toBe(first.compactionProgress)
    for (const branch of ["contextUsage"] as const) {
      expect(second[branch]).toBe(first[branch])
      expect(first[branch]).toBe(initial[branch])
    }
    expect(contextReads.mock.calls.length).toBe(readsBefore)
    expect(saves).not.toHaveBeenCalled()
    releaseFinish.resolve()
    const checkpoint = await task
    expect(checkpoint?.id).toBe("candidate")
    expect(saves).toHaveBeenCalledTimes(1)
    expect(session.getSnapshot()).toMatchObject({ isCompacting: false })
    expect(session.loadHistoryPage("main").checkpoint).toEqual(checkpoint)
    expect(session.getSnapshot()).not.toHaveProperty("compactionProgress")
    expect(publications.filter((snapshot) => snapshot.compactionProgress)
      .every((snapshot) => snapshot.isCompacting)).toBe(true)
    expect(manager.loadRequiredContext("session-1").messages).toEqual([])
    expect(await session.compact()).toBeUndefined()
    expect(session.getSnapshot()).not.toHaveProperty("compactionProgress")
    expect(saves).toHaveBeenCalledTimes(1)
  } finally {
    releaseSecond.resolve()
    releaseFinish.resolve()
    await task.catch(() => undefined)
    saves.mockRestore()
    contextReads.mockRestore()
    await session.dispose()
  }
})

test.each(["provider-error", "truncated", "unfinished", "empty", "oversized", "save-error", "save-undefined"] as const)(
  "AgentSession clears %s compaction previews without replacing the previous checkpoint",
  async (failure) => {
    const manager = new SQLiteSessionManager({ databasePath: ":memory:" })
    manager.createSession(sessionInfo("session-1", "test-agent", "Rejected progress"))
    seedConversation(manager, 2, "X".repeat(1_000))
    const previous = compactionCheckpoint()
    manager.saveCompactionCheckpoint(previous)
    const saves = spyOn(manager, "saveCompactionCheckpoint")
    const saveFails = failure === "save-error" || failure === "save-undefined"
    if (saveFails) {
      saves.mockImplementation(() => {
        throw failure === "save-undefined" ? undefined : new Error("Save failed")
      })
    }
    const published = Promise.withResolvers<void>()
    const releaseFinish = Promise.withResolvers<void>()
    const session = new AgentSession({
      agentId: "test-agent",
      sessionId: "session-1",
      manager,
      systemPrompt: "System",
      resolveRunConfiguration: () => ({
        model: {
          async *stream() {
            yield {
              type: "text-delta", id: "summary",
              delta: failure === "empty" ? "   " : failure === "oversized" ? "X".repeat(50_000) : "Candidate",
            }
            published.resolve()
            await releaseFinish.promise
            if (failure === "provider-error") {
              yield { type: "error", error: new Error("Provider failed") }
            } else if (failure !== "unfinished") {
              yield { type: "finish", reason: failure === "truncated" ? "max_output_tokens" : "stop" }
            }
          },
        },
        reasoningEffort: "medium",
      }),
      tools: [],
    })
    const initialContext = manager.loadRequiredContext("session-1")
    const task = session.compact().then(
      (checkpoint) => ({ rejected: false, checkpoint, error: undefined }),
      (error: unknown) => ({ rejected: true, checkpoint: undefined, error }),
    )
    try {
      await Promise.race([published.promise, task])
      expect(session.getSnapshot().compactionProgress).toBeDefined()
      expect(saves).not.toHaveBeenCalled()
      releaseFinish.resolve()
      const result = await task
      expect(result.checkpoint).toBeUndefined()
      expect(result.rejected).toBe(failure !== "oversized")
      if (failure === "oversized" || failure === "save-undefined") expect(result.error).toBeUndefined()
      else expect(result.error).toBeInstanceOf(Error)
      expect(saves).toHaveBeenCalledTimes(saveFails ? 1 : 0)
      if (saveFails) {
        expect(() => session.prompt("Must not run after failed checkpoint save"))
          .toThrow("Session persistence failed. Reopen the session")
        expect(() => session.compact()).toThrow("Session persistence failed. Reopen the session")
      }
      expect(session.getSnapshot().isCompacting).toBe(false)
      expect(session.getSnapshot()).not.toHaveProperty("compactionProgress")
      expect(session.loadHistoryPage("main").checkpoint).toEqual(previous)
      expect(manager.getCompactionCheckpoint("session-1")).toEqual(previous)
      expect(manager.loadRequiredContext("session-1")).toEqual(initialContext)
    } finally {
      releaseFinish.resolve()
      await task
      saves.mockRestore()
      await session.dispose()
    }
  },
)

test.each(["abort", "dispose"] as const)("AgentSession clears progress immediately on %s and ignores late deltas", async (action) => {
  const manager = new SQLiteSessionManager({ databasePath: ":memory:" })
  manager.createSession(sessionInfo("session-1", "test-agent", "Cancelled progress"))
  seedConversation(manager, 2, "X".repeat(1_000))
  manager.saveCompactionCheckpoint(compactionCheckpoint())
  const published = Promise.withResolvers<void>()
  const releaseLate = Promise.withResolvers<void>()
  const session = new AgentSession({
    agentId: "test-agent",
    sessionId: "session-1",
    manager,
    systemPrompt: "System",
    resolveRunConfiguration: () => ({
      model: {
        async *stream() {
          yield { type: "text-delta", id: "summary", delta: "Candidate" }
          published.resolve()
          await releaseLate.promise
          yield { type: "text-delta", id: "summary", delta: " late" }
          yield { type: "finish", reason: "stop" }
        },
      },
      reasoningEffort: "medium",
    }),
    tools: [],
    disposeTimeoutMs: 10,
  })
  const publications: ISessionSnapshot[] = []
  session.subscribe(() => publications.push(session.getSnapshot()))
  const task = session.compact().then(() => undefined, (error: unknown) => error)
  try {
    await Promise.race([published.promise, task])
    expect(session.getSnapshot().compactionProgress?.summary).toBe("Candidate")
    const publicationsBeforeCancel = publications.length
    const stopped = action === "abort" ? session.abort() : session.dispose()
    expect(session.getSnapshot()).not.toHaveProperty("compactionProgress")
    if (action === "dispose") {
      await expect(stopped).rejects.toThrow("Timed out waiting for AgentSession to stop")
      expect(publications).toHaveLength(publicationsBeforeCancel)
    }
    releaseLate.resolve()
    expect(await task).toBe(action === "abort" ? "Buli interaction was aborted" : "AgentSession is shutting down")
    if (action === "abort") await stopped
    expect(session.getSnapshot().isCompacting).toBe(false)
    expect(session.getSnapshot()).not.toHaveProperty("compactionProgress")
    expect(manager.getCompactionCheckpoint("session-1")).toEqual(compactionCheckpoint())
    expect(publications.slice(publicationsBeforeCancel).every((snapshot) => !snapshot.compactionProgress)).toBe(true)
  } finally {
    releaseLate.resolve()
    await task
    await session.dispose().catch(() => undefined)
  }
})

test("AgentSession compacts durable history into one cumulative checkpoint", async () => {
  const manager = new SQLiteSessionManager({ databasePath: ":memory:" })
  manager.createSession(sessionInfo("session-1", "test-agent", "Compaction"))
  seedConversation(manager, 3, "x".repeat(50_000))
  const original = manager.loadRequiredContext("session-1").messages
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
  expect(session.loadHistoryPage("main").messages).toEqual(original)
  expect(await session.compact()).toBeUndefined()

  const run = session.prompt("Continue")
  await run.runFinished
  const promptRequest = requests.find(
    (request) => !request.runId.startsWith("compaction-"),
  )
  expect(promptRequest?.contextSummary).toBe(structuredSummary("Earlier context"))
  expect(promptRequest?.messages.slice(0, -1)).toEqual(original.slice(6))
  expect(session.loadHistoryPage("main").messages.slice(0, 6)).toEqual([...original])
  expect(manager.loadRequiredContext("session-1").messages.at(-1)).toMatchObject({
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
  const manager = new SQLiteSessionManager({ databasePath: ":memory:" })
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
  await run.runFinished
  await session.waitForIdle()

  expect(compactionRequests).toBe(0)
  expect(manager.getCompactionCheckpoint("session-1")).toBeUndefined()
  expect(session.getSnapshot().contextUsage).toMatchObject({
    contextWindowTokens: 4_096,
    shouldCompact: false,
  })
  expect(manager.loadRequiredContext("session-1").messages).toHaveLength(8)

  await session.dispose()
})

function compactionCheckpoint() {
  return {
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
}

function operationalSnapshot(): ISessionSnapshot {
  return {
    activeBranchId: "main",
    pendingSteeringMessages: [],
    pendingFollowUpMessages: [],
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
  manager: SQLiteSessionManager,
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
