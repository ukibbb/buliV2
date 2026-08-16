import { expect, test } from "bun:test"
import type { IBuliPromptInput } from "@/application/contracts"
import {
  BuliApplicationRuntime,
  type IBuliAgentRegistration,
} from "@/application/runtime"
import type {
  IAgentModel,
  IAgentModelEvent,
  IAgentModelRequest,
  IAgentTool,
} from "@/agent/agent-types"
import {
  InMemorySessionManager,
  type ISessionManager,
} from "@/session/session-manager"

const WORKSPACE_ROOT = "/workspace"
const TEST_AGENT_ID = "test-agent"

const model: IAgentModel = {
  async *stream() {},
}

const TEST_AGENTS: readonly IBuliAgentRegistration[] = [{
  id: TEST_AGENT_ID,
  name: "Test Agent",
  systemPrompt: "System",
  tools: [],
}]

function runtimeWith(
  modelOverride: IAgentModel = model,
  agents: readonly IBuliAgentRegistration[] = TEST_AGENTS,
  manager: ISessionManager = new InMemorySessionManager(),
): BuliApplicationRuntime {
  let sessionNumber = 0
  return new BuliApplicationRuntime({
    manager,
    agents,
    defaultAgentId: TEST_AGENT_ID,
    models: [{
      id: "test",
      name: "Test",
      model: modelOverride,
      reasoningEfforts: ["medium"],
    }],
    selection: {
      modelId: "test",
      reasoningEffort: "medium",
    },
    workspaceRoot: WORKSPACE_ROOT,
    now: () => 100 + sessionNumber,
    generateId: () => `session-${++sessionNumber}`,
  })
}

function createSession(
  runtime: BuliApplicationRuntime,
) {
  const info = runtime.createSession({
    agentId: TEST_AGENT_ID,
    title: "Test session",
  })
  return runtime.openSession(info.id)
}

test("application runtime submits prompts into its session view", async () => {
  const events: IAgentModelEvent[] = [
    { type: "text-start", id: "answer" },
    { type: "text-delta", id: "answer", delta: "Hello from Buli" },
    { type: "text-end", id: "answer" },
    { type: "finish", reason: "stop" },
  ]
  const runtime = runtimeWith({
      async *stream() {
        yield* events
      },
  })
  const input: IBuliPromptInput = { sessionId: "session-1", text: "Hello" }
  const view = createSession(runtime)
  const initial = view.getSnapshot()

  const submission = runtime.submitPrompt(input)
  await submission.accepted
  await submission.settled

  expect(submission.sessionId).toBe("session-1")
  expect(view.getSnapshot()).not.toBe(initial)
  expect(view.getSnapshot().messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
  ])
  expect(view.getSnapshot().messages[1]?.content).toContainEqual(
    expect.objectContaining({ type: "text", text: "Hello from Buli" }),
  )
  expect(view.getSnapshot().messages).toEqual([
    expect.objectContaining({
      runId: submission.runId,
      source: "prompt",
    }),
    expect.objectContaining({ runId: submission.runId }),
  ])

  await runtime.dispose()
})

test("application runtime queues and clears steering and follow-up", async () => {
  const firstStarted = Promise.withResolvers<void>()
  const releaseFirst = Promise.withResolvers<void>()
  const requests: IAgentModelRequest[] = []
  const runtime = runtimeWith({
    async *stream(request) {
      requests.push({
        ...request,
        messages: structuredClone(request.messages),
        tools: structuredClone(request.tools),
      })
      if (requests.length === 1) {
        firstStarted.resolve()
        await releaseFirst.promise
      }
      yield { type: "finish", reason: "stop" }
    },
  })
  const view = createSession(runtime)
  const submission = runtime.submitPrompt({
    sessionId: "session-1",
    text: "Initial prompt",
  })
  await submission.accepted
  await firstStarted.promise

  runtime.steer("session-1", "Restore this")
  runtime.followUp("session-1", "Restore this later")
  expect(runtime.clearQueuedMessages("session-1")).toEqual({
    steering: ["Restore this"],
    followUp: ["Restore this later"],
  })
  runtime.steer("session-1", "Adjust the answer")
  runtime.followUp("session-1", "Then summarize it")
  expect(view.getSnapshot().pendingSteeringMessages).toEqual([
    expect.objectContaining({
      runId: submission.runId,
      source: "steer",
      content: "Adjust the answer",
    }),
  ])
  expect(view.getSnapshot().pendingFollowUpMessages).toEqual([
    expect.objectContaining({
      runId: submission.runId,
      source: "followUp",
      content: "Then summarize it",
    }),
  ])

  releaseFirst.resolve()
  await submission.settled

  expect(requests).toHaveLength(3)
  expect(requests[1]?.messages.at(-1)).toMatchObject({
    runId: submission.runId,
    source: "steer",
    content: "Adjust the answer",
  })
  expect(requests[2]?.messages.at(-1)).toMatchObject({
    runId: submission.runId,
    source: "followUp",
    content: "Then summarize it",
  })
  expect(view.getSnapshot().pendingSteeringMessages).toEqual([])
  expect(view.getSnapshot().pendingFollowUpMessages).toEqual([])
  expect(() => runtime.steer("session-1", "Too late")).toThrow(
    "Agent is not accepting steering messages",
  )
  expect(() => runtime.followUp("session-1", "Too late")).toThrow(
    "Agent is not accepting follow-up messages",
  )

  await runtime.dispose()
})

test("application runtime rejects blank prompts", async () => {
  const runtime = runtimeWith()
  const view = createSession(runtime)

  expect(() => runtime.submitPrompt({
    sessionId: "session-1",
    text: "   ",
  })).toThrow("Prompt cannot be empty")

  expect(view.getSnapshot().messages).toEqual([])
  await runtime.dispose()
})

test("application runtime returns one stable view per session", async () => {
  const runtime = runtimeWith()

  const first = createSession(runtime)
  const second = runtime.openSession("session-1")
  const other = createSession(runtime)

  expect(second).toBe(first)
  expect(other).not.toBe(first)
  expect(runtime.listSessions().map((session) => session.id)).toEqual([
    "session-2",
    "session-1",
  ])

  await runtime.dispose()
})

test("application runtime auto-opens persisted history when submitting", async () => {
  const manager = new InMemorySessionManager()
  manager.createSession({
    id: "stored-session",
    agentId: TEST_AGENT_ID,
    title: "Stored prompt",
    createdAt: 1,
    updatedAt: 2,
  })
  manager.appendMessage({
    id: "stored-user",
    sessionId: "stored-session",
    runId: "stored-run",
    role: "user",
    source: "prompt",
    content: "Stored prompt",
    createdAt: 2,
  })
  const runtime = runtimeWith(model, TEST_AGENTS, manager)

  const submission = runtime.submitPrompt({
    sessionId: "stored-session",
    text: "New prompt",
  })
  await submission.accepted
  await submission.settled
  const first = runtime.openSession("stored-session")
  const second = runtime.openSession("stored-session")

  expect(second).toBe(first)
  expect(first.getSnapshot().messages).toEqual([
    expect.objectContaining({ content: "Stored prompt", runId: "stored-run" }),
    expect.objectContaining({
      content: "New prompt",
      runId: submission.runId,
      source: "prompt",
    }),
    expect.objectContaining({ role: "assistant", runId: submission.runId }),
  ])

  await runtime.dispose()
})

test("application runtime resolves fixed prompt and tools from an agent", async () => {
  const requests: IAgentModelRequest[] = []
  const reviewTool: IAgentTool = {
    name: "review",
    description: "Review code",
    inputSchema: {},
    execute: async () => "reviewed",
  }
  const agents: readonly IBuliAgentRegistration[] = [
    ...TEST_AGENTS,
    {
      id: "reviewer",
      name: "Reviewer",
      systemPrompt: "Review system",
      tools: [reviewTool],
    },
  ]
  const runtime = runtimeWith({
    async *stream(request) {
      requests.push(request)
      yield { type: "finish", reason: "stop" }
    },
  }, agents)
  const reviewSession = runtime.createSession({
    agentId: "reviewer",
    title: "Review this",
  })

  const submission = runtime.submitPrompt({
    sessionId: reviewSession.id,
    text: "Review this",
  })
  await submission.accepted
  await submission.settled

  expect(requests[0]?.systemPrompt).toBe("Review system")
  expect(requests[0]?.tools).toEqual([{
    name: "review",
    description: "Review code",
    inputSchema: {},
  }])
  expect(runtime.getSnapshot().agents).toEqual([
    { id: TEST_AGENT_ID, name: "Test Agent" },
    { id: "reviewer", name: "Reviewer" },
  ])
  expect(runtime.getSnapshot().agents[1]).not.toHaveProperty("systemPrompt")
  expect(runtime.getSnapshot().agents[1]).not.toHaveProperty("tools")

  await runtime.dispose()
})

test("application runtime applies global selection to the next prompt", async () => {
  const runs: string[] = []
  const runtime = new BuliApplicationRuntime({
    workspaceRoot: WORKSPACE_ROOT,
    manager: new InMemorySessionManager(),
    agents: TEST_AGENTS,
    defaultAgentId: TEST_AGENT_ID,
    models: [
      {
        id: "first",
        name: "First",
        reasoningEfforts: ["low", "medium"],
        model: {
          async *stream(request) {
            runs.push(`first:${request.reasoningEffort}`)
            yield { type: "finish", reason: "stop" }
          },
        },
      },
      {
        id: "second",
        name: "Second",
        reasoningEfforts: ["medium", "high"],
        model: {
          async *stream(request) {
            runs.push(`second:${request.reasoningEffort}`)
            yield { type: "finish", reason: "stop" }
          },
        },
      },
    ],
    selection: {
      modelId: "first",
      reasoningEffort: "medium",
    },
    generateId: () => "session-1",
  })
  createSession(runtime)
  const initialSnapshot = runtime.getSnapshot()
  let notifications = 0
  const unsubscribe = runtime.subscribe(() => {
    notifications += 1
  })

  const firstSubmission = runtime.submitPrompt({
    sessionId: "session-1",
    text: "First",
  })
  await firstSubmission.accepted
  await firstSubmission.settled
  runtime.selectModel("second")
  const modelSnapshot = runtime.getSnapshot()
  const secondSubmission = runtime.submitPrompt({
    sessionId: "session-1",
    text: "Second",
  })
  await secondSubmission.accepted
  await secondSubmission.settled
  runtime.selectReasoningEffort("high")
  const thirdSubmission = runtime.submitPrompt({
    sessionId: "session-1",
    text: "Third",
  })
  await thirdSubmission.accepted
  await thirdSubmission.settled

  expect(runs).toEqual([
    "first:medium",
    "second:medium",
    "second:high",
  ])
  expect(modelSnapshot).not.toBe(initialSnapshot)
  expect(modelSnapshot.selection).toEqual({
    modelId: "second",
    reasoningEffort: "medium",
  })
  expect(runtime.getSnapshot().selection).toEqual({
    modelId: "second",
    reasoningEffort: "high",
  })
  expect(notifications).toBe(2)
  expect(Object.isFrozen(runtime.getSnapshot())).toBe(true)
  expect(Object.isFrozen(runtime.getSnapshot().agents)).toBe(true)
  expect(Object.isFrozen(runtime.getSnapshot().models)).toBe(true)
  expect(Object.isFrozen(runtime.getSnapshot().selection)).toBe(true)

  unsubscribe()
  await runtime.dispose()
})

test("application runtime rejects duplicate and unknown agent IDs", async () => {
  expect(() => runtimeWith(model, [
    ...TEST_AGENTS,
    ...TEST_AGENTS,
  ])).toThrow(`Duplicate agent: ${TEST_AGENT_ID}`)

  const runtime = runtimeWith()
  expect(() => runtime.createSession({
    agentId: "missing",
    title: "Missing agent",
  })).toThrow("Unknown agent: missing")
  expect(() => runtime.openSession("session-1")).toThrow(
    "Session does not exist: session-1",
  )

  await runtime.dispose()
})

test("application runtime rejects invalid selections atomically", async () => {
  const runtime = runtimeWith()
  const snapshot = runtime.getSnapshot()
  let notifications = 0
  runtime.subscribe(() => {
    notifications += 1
  })

  runtime.selectModel("test")
  runtime.selectReasoningEffort("medium")

  expect(() => runtime.selectModel("missing")).toThrow(
    "Unknown model: missing",
  )
  expect(() => runtime.selectReasoningEffort("high")).toThrow(
    "Unsupported reasoning effort: high",
  )
  expect(runtime.getSnapshot()).toBe(snapshot)
  expect(notifications).toBe(0)

  await runtime.dispose()
})

test("application runtime creates and reopens one stable session", async () => {
  const runtime = runtimeWith()

  const info = runtime.createSession({
    agentId: TEST_AGENT_ID,
    title: "  First\n session  ",
  })
  const session = runtime.openSession(info.id)

  expect(info).toEqual({
    id: "session-1",
    agentId: TEST_AGENT_ID,
    title: "First session",
    createdAt: 101,
    updatedAt: 101,
  })
  expect(runtime.openSession(info.id)).toBe(session)
  expect(runtime.listSessions()).toEqual([info])

  await runtime.dispose()
})

test("submitPrompt creates a default-agent session when sessionId is omitted", async () => {
  const runtime = runtimeWith({
    async *stream() {
      yield { type: "finish", reason: "stop" }
    },
  })

  const submission = runtime.submitPrompt({ text: "  New\n session  " })

  expect(submission.sessionId).toBe("session-1")
  expect(runtime.listSessions()).toEqual([{
    id: "session-1",
    agentId: TEST_AGENT_ID,
    title: "New session",
    createdAt: 101,
    updatedAt: 101,
  }])

  await submission.accepted
  await submission.settled
  expect(runtime.openSession(submission.sessionId).getSnapshot().messages[0])
    .toMatchObject({
      role: "user",
      source: "prompt",
      runId: submission.runId,
      content: "  New\n session  ",
    })

  await runtime.dispose()
})

test("submitPrompt rolls back a new session when its first prompt is not accepted", async () => {
  const memory = new InMemorySessionManager()
  const persistenceFailure = new Error("Disk write failed")
  const deletedSessionIds: string[] = []
  const manager: ISessionManager = {
    createSession: memory.createSession,
    getSessionInfo: memory.getSessionInfo,
    listSessions: memory.listSessions,
    getMessages: memory.getMessages,
    appendMessage: () => {
      throw persistenceFailure
    },
    clearSession: memory.clearSession,
    deleteSession: (sessionId) => {
      deletedSessionIds.push(sessionId)
      memory.deleteSession(sessionId)
    },
  }
  const runtime = runtimeWith(model, TEST_AGENTS, manager)

  const submission = runtime.submitPrompt({ text: "New session" })
  const acceptanceFailure = submission.accepted.then(
    () => undefined,
    (error: unknown) => error,
  )
  const settlementFailure = submission.settled.then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(manager.getSessionInfo(submission.sessionId)).toBeDefined()

  expect(await acceptanceFailure).toBe(persistenceFailure)
  expect(await settlementFailure).toBe(persistenceFailure)
  expect(deletedSessionIds).toEqual([submission.sessionId])
  expect(runtime.listSessions()).toEqual([])
  expect(manager.listSessions()).toEqual([])
  expect(manager.getSessionInfo(submission.sessionId)).toBeUndefined()
  expect(manager.getMessages(submission.sessionId)).toEqual([])
  expect(() => runtime.openSession(submission.sessionId)).toThrow(
    `Session does not exist: ${submission.sessionId}`,
  )

  await runtime.dispose()
})

test("new-session settled waits for rollback before exposing failure", async () => {
  const memory = new InMemorySessionManager()
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
  const runtime = runtimeWith(model, TEST_AGENTS, manager)
  const rollbackStarted = Promise.withResolvers<void>()
  const releaseRollback = Promise.withResolvers<void>()
  const runtimeInternals = runtime as unknown as {
    rollbackSession: (
      sessionId: string,
      session: unknown,
    ) => Promise<void>
  }
  const rollbackSession = runtimeInternals.rollbackSession.bind(runtime)
  runtimeInternals.rollbackSession = async (sessionId, session) => {
    rollbackStarted.resolve()
    await releaseRollback.promise
    await rollbackSession(sessionId, session)
  }

  const submission = runtime.submitPrompt({ text: "New session" })
  let settlementObserved = false
  const settlementFailure = submission.settled.then(
    () => {
      settlementObserved = true
      return undefined
    },
    (error: unknown) => {
      settlementObserved = true
      return error
    },
  )

  await rollbackStarted.promise
  expect(settlementObserved).toBe(false)
  expect(runtime.listSessions().map((session) => session.id)).toEqual([
    submission.sessionId,
  ])

  releaseRollback.resolve()

  expect(await settlementFailure).toBe(persistenceFailure)
  expect(runtime.listSessions()).toEqual([])
  expect(manager.getSessionInfo(submission.sessionId)).toBeUndefined()
  expect(() => runtime.openSession(submission.sessionId)).toThrow(
    `Session does not exist: ${submission.sessionId}`,
  )

  await runtime.dispose()
})

test("application runtime awaits abort and rejects it after disposal", async () => {
  const runtime = runtimeWith()

  await expect(runtime.abort("session-1")).resolves.toBeUndefined()

  await runtime.dispose()
  await expect(runtime.abort("session-1")).rejects.toThrow(
    "Buli runtime is disposed",
  )
})

test("clears sessions explicitly and treats slash input as prompts", async () => {
  let interactionCount = 0
  const runtime = runtimeWith({
      async *stream() {
        interactionCount += 1
        yield { type: "finish", reason: "stop" }
      },
  })
  const view = createSession(runtime)

  const oldSubmission = runtime.submitPrompt({
    sessionId: "session-1",
    text: "Old question",
  })
  await oldSubmission.accepted
  await oldSubmission.settled

  expect(interactionCount).toBe(1)
  expect(view.getSnapshot().messages).toHaveLength(2)

  runtime.clearSession("session-1")

  expect(interactionCount).toBe(1)
  expect(view.getSnapshot().messages).toEqual([])

  const slashSubmission = runtime.submitPrompt({
    sessionId: "session-1",
    text: "/clear",
  })
  await slashSubmission.accepted
  await slashSubmission.settled

  expect(interactionCount).toBe(2)
  expect(view.getSnapshot().messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
  ])

  await runtime.dispose()
})
