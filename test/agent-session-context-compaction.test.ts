import { expect, test } from "bun:test"

import {
  type TAgentMessage,
  type IAgentModel,
  type IAgentModelRequest,
  type IAgentTool,
  ModelContextOverflowError,
} from "@/agent"
import {
  AgentSession,
  contextCompactionThresholdTokens,
  estimateContextInputTokens,
  InMemorySessionManager,
  type ISessionManager,
} from "@/sessions"

const MODEL_PROFILE = {
  providerId: "test",
  modelId: "context-model",
  contextWindowTokens: 16_000,
} as const

test("AgentSession dispatches below-threshold requests without compaction", async () => {
  const manager = managerWithSession()
  const requests: IAgentModelRequest[] = []
  const session = openSession(manager, {
    async *stream(request) {
      requests.push(cloneRequest(request))
      yield { type: "finish", reason: "stop" }
    },
  })

  expect(session.getSnapshot()).toMatchObject({
    isCompacting: false,
    contextUsage: {
      contextWindowTokens: MODEL_PROFILE.contextWindowTokens,
      shouldCompact: false,
    },
  })

  const run = session.prompt("Short question")
  await run.settled

  expect(requests).toHaveLength(1)
  expect(requests[0]?.messages.at(-1)).toMatchObject({
    role: "user",
    content: "Short question",
  })
  expect(manager.getCompactionCheckpoint("session-1")).toBeUndefined()
  expect(session.getSnapshot().contextUsage?.shouldCompact).toBe(false)

  await session.dispose()
})

test("AgentSession compacts at preflight and dispatches the same durable prompt", async () => {
  const manager = managerWithSession()
  seedLargeTurns(manager, 2)
  const summaryRequests: IAgentModelRequest[] = []
  const conversationRequests: IAgentModelRequest[] = []
  const model: IAgentModel = {
    async *stream(request) {
      if (isCompactionRequest(request)) {
        summaryRequests.push(cloneRequest(request))
        yield {
          type: "text-delta",
          id: "summary",
          delta: structuredSummary("Earlier summary"),
        }
        yield { type: "finish", reason: "stop" }
        return
      }
      conversationRequests.push(cloneRequest(request))
      yield { type: "finish", reason: "stop" }
    },
  }
  const session = openSession(manager, model)
  const snapshots: Array<{
    readonly isCompacting: boolean
    readonly shouldCompact: boolean | undefined
  }> = []
  session.subscribe(() => {
    const snapshot = session.getSnapshot()
    snapshots.push({
      isCompacting: snapshot.isCompacting ?? false,
      shouldCompact: snapshot.contextUsage?.shouldCompact,
    })
  })

  const prompt = "Keep this prompt"
  const run = session.prompt(prompt)
  await run.settled

  expect(summaryRequests).toHaveLength(1)
  expect(summaryRequests.every((request) => (
    request.reasoningEffort === "none"
    && request.tools.length === 0
    && request.messages.length === 1
    && request.messages[0]?.role === "user"
  ))).toBe(true)
  expect(conversationRequests).toHaveLength(1)
  expect(conversationRequests[0]?.reasoningEffort).toBe("medium")
  expect(manager.getCompactionCheckpoint("session-1")).toMatchObject({
    reason: "automatic",
    compactedMessageCount: 4,
    summary: structuredSummary("Earlier summary"),
  })
  const durablePrompt = manager.getMessages("session-1").find(
    (message) => message.role === "user" && message.runId === run.runId,
  )
  expect(durablePrompt).toBeDefined()
  expect(conversationRequests[0]).toMatchObject({
    runId: run.runId,
    contextSummary: structuredSummary("Earlier summary"),
  })
  expect(conversationRequests[0]?.messages).toEqual([durablePrompt!])
  expect(manager.getMessages("session-1").filter(
    (message) => message.role === "user" && message.content === prompt,
  )).toHaveLength(1)
  expect(snapshots.some((snapshot) => snapshot.shouldCompact === true)).toBe(true)
  expect(snapshots.filter((snapshot) => snapshot.isCompacting).length)
    .toBeGreaterThanOrEqual(2)
  expect(session.getSnapshot().isCompacting).toBe(false)

  await session.dispose()
})

test("AgentSession uses the active run model for automatic compaction", async () => {
  const manager = managerWithSession()
  seedLargeTurns(manager, 2)
  let resolutions = 0
  let activeModelRequests = 0
  let replacementModelRequests = 0
  const activeModel: IAgentModel = {
    async *stream(request) {
      activeModelRequests += 1
      if (isCompactionRequest(request)) {
        yield {
          type: "text-delta",
          id: "summary",
          delta: structuredSummary("Active model checkpoint"),
        }
      }
      yield { type: "finish", reason: "stop" }
    },
  }
  const replacementModel: IAgentModel = {
    async *stream(request) {
      replacementModelRequests += 1
      if (isCompactionRequest(request)) {
        yield {
          type: "text-delta",
          id: "summary",
          delta: structuredSummary("Replacement model checkpoint"),
        }
      }
      yield { type: "finish", reason: "stop" }
    },
  }
  const session = new AgentSession({
    agentId: "test-agent",
    sessionId: "session-1",
    manager,
    systemPrompt: "System",
    resolveRunConfiguration: () => {
      resolutions += 1
      const useActiveConfiguration = resolutions <= 2
      return {
        model: useActiveConfiguration ? activeModel : replacementModel,
        modelProfile: useActiveConfiguration
          ? MODEL_PROFILE
          : {
            providerId: "test-provider",
            modelId: "unexpected-small-model",
            contextWindowTokens: 2_050,
          },
        reasoningEffort: "medium",
      }
    },
    tools: [],
  })

  await session.prompt("Keep this prompt").settled

  expect(activeModelRequests).toBeGreaterThanOrEqual(2)
  expect(replacementModelRequests).toBe(0)
  expect(manager.getCompactionCheckpoint("session-1")?.summary).toBe(
    structuredSummary("Active model checkpoint"),
  )

  await session.dispose()
})

test("AgentSession keeps an unprocessed image prompt out of the checkpoint", async () => {
  const manager = managerWithSession()
  seedLargeTurns(manager, 3)
  const summaryRequests: IAgentModelRequest[] = []
  const conversationRequests: IAgentModelRequest[] = []
  const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlL8AAAAASUVORK5CYII="
  const session = openSession(manager, {
    async *stream(request) {
      if (isCompactionRequest(request)) {
        summaryRequests.push(cloneRequest(request))
        yield {
          type: "text-delta",
          id: "summary",
          delta: structuredSummary("Earlier text-only history"),
        }
        yield { type: "finish", reason: "stop" }
        return
      }
      conversationRequests.push(cloneRequest(request))
      yield { type: "finish", reason: "stop" }
    },
  }, [], 16_000)

  const run = session.prompt({
    text: "Inspect [Image 1]",
    attachments: [{
      type: "image",
      mimeType: "image/png",
      data: imageData,
      filename: "clipboard-1.png",
      source: { value: "[Image 1]", start: 8, end: 17 },
    }],
  })
  await run.settled

  expect(JSON.stringify(summaryRequests)).not.toContain(imageData)
  expect(JSON.stringify(summaryRequests)).not.toContain("clipboard-1.png")
  expect(conversationRequests).toHaveLength(1)
  expect(conversationRequests[0]?.messages).toEqual([
    expect.objectContaining({
      role: "user",
      content: "Inspect [Image 1]",
      attachments: [expect.objectContaining({
        data: imageData,
        filename: "clipboard-1.png",
      })],
    }),
  ])

  await session.dispose()
})

test("AgentSession compacts a 238k request before dispatching to a 272k model", async () => {
  const manager = managerWithSession()
  manager.appendMessage({
    id: "large-user",
    sessionId: "session-1",
    runId: "large-run",
    role: "user",
    source: "prompt",
    content: "Earlier request",
    createdAt: 2,
  })
  manager.appendMessage({
    id: "large-assistant",
    sessionId: "session-1",
    runId: "large-run",
    role: "assistant",
    content: [{ type: "text", text: "Earlier answer" }],
    stopReason: "stop",
    model: MODEL_PROFILE,
    usage: {
      inputTokens: 238_000,
      outputTokens: 200,
      totalTokens: 238_200,
    },
    createdAt: 3,
  })
  const contextWindowTokens = 272_000
  const prompt = "Keep this prompt"
  const summaryRequests: IAgentModelRequest[] = []
  const conversationRequests: IAgentModelRequest[] = []
  const session = openSession(manager, {
    async *stream(request) {
      if (isCompactionRequest(request)) {
        summaryRequests.push(cloneRequest(request))
        yield {
          type: "text-delta",
          id: "summary",
          delta: structuredSummary(`Summary ${summaryRequests.length}`),
        }
        yield { type: "finish", reason: "stop" }
        return
      }
      conversationRequests.push(cloneRequest(request))
      yield { type: "finish", reason: "stop" }
    },
  }, [], contextWindowTokens)
  const initialUsage = session.getSnapshot().contextUsage
  expect(initialUsage?.estimatedInputTokens).toBeGreaterThan(238_000)
  expect(initialUsage?.estimatedInputTokens).toBeLessThan(239_000)
  expect(initialUsage?.shouldCompact).toBe(true)

  const run = session.prompt(prompt)
  await run.settled

  expect(summaryRequests).toHaveLength(1)
  expect(summaryRequests.every((request) => (
    request.tools.length === 0
    && estimateContextInputTokens({
      systemPrompt: request.systemPrompt,
      ...(request.contextSummary === undefined
        ? {}
        : { contextSummary: request.contextSummary }),
      messages: request.messages,
      tools: request.tools,
    }) <= contextWindowTokens - 16_384
  ))).toBe(true)
  expect(conversationRequests).toHaveLength(1)
  expect(estimateContextInputTokens({
    systemPrompt: conversationRequests[0]!.systemPrompt,
    ...(conversationRequests[0]!.contextSummary === undefined
      ? {}
      : { contextSummary: conversationRequests[0]!.contextSummary }),
    messages: conversationRequests[0]!.messages,
    tools: conversationRequests[0]!.tools,
  })).toBeLessThan(contextCompactionThresholdTokens(contextWindowTokens))
  expect(conversationRequests[0]?.messages).toEqual([
    expect.objectContaining({ role: "user", content: prompt }),
  ])
  expect(manager.getCompactionCheckpoint("session-1")).toMatchObject({
    compactedMessageCount: 2,
    throughMessageId: "large-assistant",
  })

  await session.dispose()
})

test("AgentSession blocks an oversized request when compaction has no progress", async () => {
  const manager = managerWithSession()
  let conversationAttempts = 0
  let summaryAttempts = 0
  const requests: IAgentModelRequest[] = []
  const session = openSession(manager, {
    async *stream(request) {
      if (isCompactionRequest(request)) {
        summaryAttempts += 1
        yield { type: "finish", reason: "stop" }
        return
      }
      conversationAttempts += 1
      requests.push(cloneRequest(request))
      yield { type: "finish", reason: "stop" }
    },
  })

  const prompt = "P".repeat(14_000)
  const run = session.prompt(prompt)
  await run.settled

  expect(conversationAttempts).toBe(0)
  expect(summaryAttempts).toBe(0)
  expect(requests).toHaveLength(0)
  expect(manager.getCompactionCheckpoint("session-1")).toBeUndefined()
  expect(session.getSnapshot().compactionCheckpoint).toBeUndefined()
  expect(manager.getMessages("session-1").findLast(
    (message) => message.role === "assistant" && message.runId === run.runId,
  )).toMatchObject({
    stopReason: "error",
    errorMessage: expect.stringContaining("no provider request was sent"),
  })

  await session.dispose()
})

test("AgentSession aborts preflight when the summary prompt cannot fit", async () => {
  const manager = managerWithSession()
  manager.appendMessage({
    id: "oversized-user",
    sessionId: "session-1",
    runId: "oversized-run",
    role: "user",
    source: "prompt",
    content: "U".repeat(6_000),
    createdAt: 2,
  })
  manager.appendMessage({
    id: "oversized-assistant",
    sessionId: "session-1",
    runId: "oversized-run",
    role: "assistant",
    content: [{ type: "text", text: "A".repeat(6_000) }],
    stopReason: "stop",
    createdAt: 3,
  })
  let modelAttempts = 0
  const session = openSession(manager, {
    async *stream() {
      modelAttempts += 1
      yield { type: "finish", reason: "stop" }
    },
  }, [], 2_050)

  const run = session.prompt("P".repeat(3_000))
  await run.settled

  expect(modelAttempts).toBe(0)
  expect(manager.getCompactionCheckpoint("session-1")).toBeUndefined()
  expect(manager.getMessages("session-1").slice(0, 2).map((message) => message.id))
    .toEqual(["oversized-user", "oversized-assistant"])
  expect(manager.getMessages("session-1").findLast(
    (message) => message.role === "assistant" && message.runId === run.runId,
  )).toMatchObject({
    stopReason: "error",
    errorMessage: expect.stringContaining(
      "Compaction summary input does not fit the summarizer model context",
    ),
  })

  await session.dispose()
})

test("AgentSession compacts oversized tool continuations before dispatch", async () => {
  const manager = managerWithSession()
  seedTurn(manager)
  const requests: IAgentModelRequest[] = []
  let summaries = 0
  const tool: IAgentTool = {
    name: "large_result",
    description: "Returns a large result",
    inputSchema: { type: "object", additionalProperties: false },
    async execute() {
      return "R".repeat(14_000)
    },
  }
  const session = openSession(manager, {
    async *stream(request) {
      if (isCompactionRequest(request)) {
        summaries += 1
        yield {
          type: "text-delta",
          id: "summary",
          delta: structuredSummary("Old turn"),
        }
        yield { type: "finish", reason: "stop" }
        return
      }

      requests.push(cloneRequest(request))
      if (requests.length <= 2) {
        yield {
          type: "tool-call",
          toolCallId: `large-call-${requests.length}`,
          toolName: tool.name,
          input: {},
        }
        yield { type: "finish", reason: "tool-calls" }
        return
      }
      yield { type: "finish", reason: "stop" }
    },
  }, [tool])

  const run = session.prompt("Use the tool")
  await run.settled

  expect(requests).toHaveLength(3)
  expect(requests[0]?.contextSummary).toBeUndefined()
  expect(requests[1]?.contextSummary).toBe(structuredSummary("Old turn"))
  expect(requests[2]?.contextSummary).toBe(structuredSummary("Old turn"))
  expect(requests[1]?.messages).toEqual([])
  expect(requests[2]?.messages).toEqual([])
  expect(requests[2]?.messages.some((message) => message.id === "old-user"))
    .toBe(false)
  expect(summaries).toBeGreaterThanOrEqual(2)
  expect(manager.getCompactionCheckpoint("session-1")).toMatchObject({
    compactedMessageCount: 7,
    reason: "automatic",
  })

  await session.dispose()
})

for (const overflowMode of ["emitted", "thrown"] as const) {
  test(`AgentSession recovers one ${overflowMode} overflow before semantic output`, async () => {
    const manager = managerWithSession()
    seedLargeTurns(manager, 2)
    let conversationAttempts = 0
    let summaryAttempts = 0
    let checkpointBeforeRetry: string | undefined
    let publishedCheckpointBeforeRetry: string | undefined
    const requests: IAgentModelRequest[] = []
    const session = openSession(manager, {
      async *stream(request) {
        if (isCompactionRequest(request)) {
          summaryAttempts += 1
          yield {
            type: "text-delta",
            id: "summary",
            delta: structuredSummary("Recovered context"),
          }
          yield { type: "finish", reason: "stop" }
          return
        }

        conversationAttempts += 1
        requests.push(cloneRequest(request))
        if (conversationAttempts === 2) {
          checkpointBeforeRetry = manager.getCompactionCheckpoint(
            "session-1",
          )?.summary
          publishedCheckpointBeforeRetry = session.getSnapshot()
            .compactionCheckpoint?.summary
        }
        if (conversationAttempts === 1) {
          const overflow = new ModelContextOverflowError("context overflow")
          if (overflowMode === "emitted") {
            yield { type: "error", error: overflow }
            return
          }
          throw overflow
        }
        yield { type: "finish", reason: "stop" }
      },
    }, [], 100_000)

    const run = session.prompt("Retry this request")
    await run.settled

    expect(conversationAttempts).toBe(2)
    expect(summaryAttempts).toBe(1)
    expect(checkpointBeforeRetry).toBe(structuredSummary("Recovered context"))
    expect(publishedCheckpointBeforeRetry).toBe(
      structuredSummary("Recovered context"),
    )
    expect(requests[1]).toMatchObject({
      runId: run.runId,
      contextSummary: structuredSummary("Recovered context"),
    })
    expect(requests[1]?.messages).toEqual([
      expect.objectContaining({
        role: "user",
        runId: run.runId,
        content: "Retry this request",
      }),
    ])
    const runAssistants = manager.getMessages("session-1").filter(
      (message) => message.role === "assistant" && message.runId === run.runId,
    )
    expect(runAssistants).toHaveLength(1)
    expect(runAssistants[0]).toMatchObject({ stopReason: "stop" })
    expect(runAssistants[0]).not.toHaveProperty("errorMessage")
    expect(manager.getCompactionCheckpoint("session-1")).toMatchObject({
      reason: "automatic",
    })

    await session.dispose()
  })
}

test("AgentSession can compact at preflight and advance again for overflow recovery", async () => {
  const manager = managerWithSession()
  seedLargeTurns(manager, 8)
  let conversationAttempts = 0
  let summaryAttempts = 0
  const requests: IAgentModelRequest[] = []
  const session = openSession(manager, {
    async *stream(request) {
      if (isCompactionRequest(request)) {
        summaryAttempts += 1
        yield {
          type: "text-delta",
          id: "summary",
          delta: structuredSummary(
            summaryAttempts === 1
              ? "Initial checkpoint ".repeat(100)
              : "Recompressed checkpoint",
          ),
        }
        yield { type: "finish", reason: "stop" }
        return
      }

      conversationAttempts += 1
      requests.push(cloneRequest(request))
      if (conversationAttempts === 1) {
        throw new ModelContextOverflowError("overflow after preflight")
      }
      yield { type: "finish", reason: "stop" }
    },
  }, [], 60_000)

  const run = session.prompt("Keep this prompt")
  await run.settled

  expect(summaryAttempts).toBe(2)
  expect(conversationAttempts).toBe(2)
  expect(requests[0]?.contextSummary).toBe(
    structuredSummary("Initial checkpoint ".repeat(100)),
  )
  expect(requests[0]?.messages).toEqual([
    expect.objectContaining({
      role: "user",
      runId: run.runId,
      content: "Keep this prompt",
    }),
  ])
  expect(requests[1]).toMatchObject({
    runId: run.runId,
    contextSummary: structuredSummary("Recompressed checkpoint"),
  })
  expect(requests[1]?.messages).toEqual([
    expect.objectContaining({
      role: "user",
      runId: run.runId,
      content: "Keep this prompt",
    }),
  ])
  expect(manager.getCompactionCheckpoint("session-1")).toMatchObject({
    compactedMessageCount: 16,
    summary: structuredSummary("Recompressed checkpoint"),
  })
  expect(session.getSnapshot().compactionCheckpoint).toMatchObject({
    compactedMessageCount: 16,
    summary: structuredSummary("Recompressed checkpoint"),
  })

  await session.dispose()
})

test("AgentSession does not retry overflow after exposing semantic output", async () => {
  const manager = managerWithSession()
  seedTurn(manager)
  let conversationAttempts = 0
  let summaryAttempts = 0
  const session = openSession(manager, {
    async *stream(request) {
      if (isCompactionRequest(request)) {
        summaryAttempts += 1
        yield { type: "finish", reason: "stop" }
        return
      }
      conversationAttempts += 1
      yield { type: "text-start", id: "answer" }
      yield { type: "text-delta", id: "answer", delta: "Partial answer" }
      throw new ModelContextOverflowError("late overflow")
    },
  }, [], 100_000)

  const run = session.prompt("Do not replay output")
  await run.settled

  expect(conversationAttempts).toBe(1)
  expect(summaryAttempts).toBe(0)
  expect(manager.getCompactionCheckpoint("session-1")).toBeUndefined()
  expect(manager.getMessages("session-1").findLast(
    (message) => message.role === "assistant" && message.runId === run.runId,
  )).toMatchObject({
    stopReason: "error",
    errorMessage: "late overflow",
    content: [{ type: "text", text: "Partial answer" }],
  })

  await session.dispose()
})

test("AgentSession surfaces a second overflow without another retry", async () => {
  const manager = managerWithSession()
  seedLargeTurns(manager, 2)
  let conversationAttempts = 0
  let summaryAttempts = 0
  const session = openSession(manager, {
    async *stream(request) {
      if (isCompactionRequest(request)) {
        summaryAttempts += 1
        yield {
          type: "text-delta",
          id: "summary",
          delta: structuredSummary("One retry"),
        }
        yield { type: "finish", reason: "stop" }
        return
      }
      conversationAttempts += 1
      throw new ModelContextOverflowError(
        `overflow-${conversationAttempts}`,
      )
    },
  }, [], 100_000)

  const run = session.prompt("Retry only once")
  await run.settled

  expect(conversationAttempts).toBe(2)
  expect(summaryAttempts).toBe(1)
  expect(manager.getMessages("session-1").findLast(
    (message) => message.role === "assistant" && message.runId === run.runId,
  )).toMatchObject({
    stopReason: "error",
    errorMessage: "overflow-2",
  })

  await session.dispose()
})

test("AgentSession surfaces overflow without retry when compaction cannot advance", async () => {
  const manager = managerWithSession()
  let conversationAttempts = 0
  let summaryAttempts = 0
  const compactionStates: boolean[] = []
  const session = openSession(manager, {
    async *stream(request) {
      if (isCompactionRequest(request)) {
        summaryAttempts += 1
        yield { type: "finish", reason: "stop" }
        return
      }
      conversationAttempts += 1
      throw new ModelContextOverflowError("no history to compact")
    },
  }, [], 100_000)
  session.subscribe(() => {
    compactionStates.push(session.getSnapshot().isCompacting ?? false)
  })

  const run = session.prompt("Only current turn")
  await run.settled

  expect(conversationAttempts).toBe(1)
  expect(summaryAttempts).toBe(0)
  expect(manager.getCompactionCheckpoint("session-1")).toBeUndefined()
  expect(session.getSnapshot().compactionCheckpoint).toBeUndefined()
  expect(compactionStates).toContain(true)
  expect(session.getSnapshot().isCompacting).toBe(false)
  expect(manager.getMessages("session-1").findLast(
    (message) => message.role === "assistant" && message.runId === run.runId,
  )).toMatchObject({
    stopReason: "error",
    errorMessage: "no history to compact",
  })

  await session.dispose()
})

test("AgentSession aborts preflight compaction without saving a checkpoint", async () => {
  const memory = managerWithSession()
  seedTurn(memory)
  let checkpointSaves = 0
  const manager: ISessionManager = {
    createSession: memory.createSession,
    getSessionInfo: memory.getSessionInfo,
    listSessions: memory.listSessions,
    getMessages: memory.getMessages,
    appendMessage: memory.appendMessage,
    getFileChangeProposals: memory.getFileChangeProposals,
    saveFileChangeProposal: memory.saveFileChangeProposal,
    getCompactionCheckpoint: memory.getCompactionCheckpoint,
    saveCompactionCheckpoint: (checkpoint) => {
      checkpointSaves += 1
      memory.saveCompactionCheckpoint(checkpoint)
    },
    deleteSession: memory.deleteSession,
  }
  const summaryStarted = Promise.withResolvers<void>()
  let conversationAttempts = 0
  const session = openSession(manager, {
    async *stream(request) {
      if (!isCompactionRequest(request)) {
        conversationAttempts += 1
        yield { type: "finish", reason: "stop" }
        return
      }

      summaryStarted.resolve()
      await waitForAbort(request.signal)
      request.signal.throwIfAborted()
    },
  })
  const compactionStates: boolean[] = []
  session.subscribe(() => {
    compactionStates.push(session.getSnapshot().isCompacting ?? false)
  })

  const run = session.prompt("P".repeat(14_000))
  await run.accepted
  await summaryStarted.promise
  await session.abort()

  expect(conversationAttempts).toBe(0)
  expect(checkpointSaves).toBe(0)
  expect(manager.getCompactionCheckpoint("session-1")).toBeUndefined()
  expect(session.getSnapshot().compactionCheckpoint).toBeUndefined()
  expect(compactionStates.filter(Boolean).length).toBeGreaterThanOrEqual(2)
  expect(session.getSnapshot().isCompacting).toBe(false)

  await session.dispose()
})

function openSession(
  manager: ISessionManager,
  model: IAgentModel,
  tools: readonly IAgentTool[] = [],
  contextWindowTokens: number = MODEL_PROFILE.contextWindowTokens,
): AgentSession {
  return new AgentSession({
    agentId: "test-agent",
    sessionId: "session-1",
    manager,
    systemPrompt: "System",
    resolveRunConfiguration: () => ({
      model,
      modelProfile: {
        ...MODEL_PROFILE,
        contextWindowTokens,
      },
      reasoningEffort: "medium",
    }),
    tools,
  })
}

function managerWithSession(): InMemorySessionManager {
  const manager = new InMemorySessionManager()
  manager.createSession({
    id: "session-1",
    agentId: "test-agent",
    title: "Context compaction",
    createdAt: 1,
    updatedAt: 1,
  })
  return manager
}

function seedTurn(manager: InMemorySessionManager): void {
  const messages: readonly TAgentMessage[] = [
    {
      id: "old-user",
      sessionId: "session-1",
      runId: "old-run",
      role: "user",
      source: "prompt",
      content: "Earlier question",
      createdAt: 2,
    },
    {
      id: "old-assistant",
      sessionId: "session-1",
      runId: "old-run",
      role: "assistant",
      content: [{ type: "text", text: "Earlier answer" }],
      stopReason: "stop",
      createdAt: 3,
    },
  ]
  for (const message of messages) manager.appendMessage(message)
}

function seedLargeTurns(
  manager: InMemorySessionManager,
  turns: number,
): void {
  for (let index = 0; index < turns; index += 1) {
    const runId = `large-run-${index}`
    manager.appendMessage({
      id: `large-user-${index}`,
      sessionId: "session-1",
      runId,
      role: "user",
      source: "prompt",
      content: `Question ${index} ${"U".repeat(3_200)}`,
      createdAt: index * 2 + 2,
    })
    manager.appendMessage({
      id: `large-assistant-${index}`,
      sessionId: "session-1",
      runId,
      role: "assistant",
      content: [{
        type: "text",
        text: `Answer ${index} ${"A".repeat(3_200)}`,
      }],
      stopReason: "stop",
      createdAt: index * 2 + 3,
    })
  }
}

function cloneRequest(request: IAgentModelRequest): IAgentModelRequest {
  return {
    ...request,
    messages: structuredClone(request.messages),
    tools: structuredClone(request.tools),
  }
}

function isCompactionRequest(request: IAgentModelRequest): boolean {
  return request.runId.startsWith("compaction-")
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

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true })
  })
}
