import { expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { IAgentDefinition } from "@/agent/definition"
import type { IBuliPromptInput } from "@/app/contracts"
import {
  BuliApplicationRuntime,
  type IBuliModelRuntimeConfig,
  type IBuliRuntimeOptions,
} from "@/app/runtime"
import type {
  IAgentModel,
  TAgentModelEvent,
  IAgentModelRequest,
} from "@/agent/model"
import { defineAgentTool } from "@/agent/tool"
import {
  AgentSession,
  InMemorySessionManager,
  WorkspaceSessionManager,
  type ISessionManager,
} from "@/sessions"

const WORKSPACE_ROOT = "/workspace"
const TEST_AGENT_ID = "test-agent"

const model: IAgentModel = {
  async *stream() {},
}

const TEST_AGENTS: readonly IAgentDefinition[] = [{
  id: TEST_AGENT_ID,
  name: "Test Agent",
  systemPrompt: "System",
  tools: [],
}]

const CATALOG_BASE: IBuliModelRuntimeConfig = {
  id: "base",
  name: "Base",
  model,
  modelProfile: {
    providerId: "test",
    modelId: "base",
    contextWindowTokens: 200_000,
  },
  reasoningEfforts: ["medium", "high"],
  defaultReasoningEffort: "high",
}
const CATALOG_FAST: IBuliModelRuntimeConfig = {
  ...CATALOG_BASE,
  id: "base::fast",
  name: "Base Fast",
  fallbackSelectionId: "base",
}
const CATALOG_OTHER: IBuliModelRuntimeConfig = {
  id: "other",
  name: "Other",
  model,
  reasoningEfforts: ["medium", "high"],
  defaultReasoningEffort: "medium",
}
// An unrelated first entry proves priority/fallback selection is not list order.
const CATALOG_MODELS = [CATALOG_OTHER, CATALOG_BASE, CATALOG_FAST]

function runtimeWithPreferredModels(
  options: Partial<IBuliRuntimeOptions> = {},
): BuliApplicationRuntime {
  let sessionNumber = 0
  return new BuliApplicationRuntime({
    workspaceRoot: WORKSPACE_ROOT,
    manager: new InMemorySessionManager(),
    agents: TEST_AGENTS,
    defaultAgentId: TEST_AGENT_ID,
    models: [{
      ...CATALOG_BASE,
      name: "Provisional base",
      modelProfile: {
        providerId: "test",
        modelId: "base",
        contextWindowTokens: 1_000,
      },
      reasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "medium",
    }],
    selection: { modelId: "base", reasoningEffort: "medium" },
    preferredModelIds: ["base::fast", "base"],
    loadModels: async () => CATALOG_MODELS,
    generateId: () => `session-${++sessionNumber}`,
    ...options,
  })
}

function runtimeWith(
  modelOverride: IAgentModel = model,
  agents: readonly IAgentDefinition[] = TEST_AGENTS,
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
      defaultReasoningEffort: "medium",
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
  const events: TAgentModelEvent[] = [
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
  expect(runtime.getSnapshot()).not.toHaveProperty("modelCatalog")
  const input: IBuliPromptInput = { sessionId: "session-1", text: "Hello" }
  const view = createSession(runtime)
  const initial = view.getSnapshot()

  const promptRun = runtime.submitPrompt(input)
  await promptRun.promptPersisted
  await promptRun.runFinished

  expect(promptRun.sessionId).toBe("session-1")
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
      runId: promptRun.runId,
      source: "prompt",
    }),
    expect.objectContaining({ runId: promptRun.runId }),
  ])

  await runtime.dispose()
})

test("runtime hands off file ownership and reloads history into model context", async () => {
  const directoryPath = await mkdtemp(join(tmpdir(), "buli-runtime-handoff-"))
  const managers: WorkspaceSessionManager[] = []
  const runtimes: BuliApplicationRuntime[] = []
  const modelRequests: string[][] = []
  const recordingModel: IAgentModel = {
    async *stream(request) {
      modelRequests.push(request.messages
        .filter((message) => message.role === "user")
        .map((message) => message.content))
      yield { type: "finish", reason: "stop" }
    },
  }
  const createRuntime = (sessionId: string): BuliApplicationRuntime => {
    const manager = new WorkspaceSessionManager({ directoryPath })
    managers.push(manager)
    const runtime = new BuliApplicationRuntime({
      workspaceRoot: directoryPath,
      manager,
      agents: TEST_AGENTS,
      defaultAgentId: TEST_AGENT_ID,
      models: [{
        id: "test",
        name: "Test",
        model: recordingModel,
        reasoningEfforts: ["medium"],
        defaultReasoningEffort: "medium",
      }],
      selection: { modelId: "test", reasoningEffort: "medium" },
      generateId: () => sessionId,
    })
    runtimes.push(runtime)
    return runtime
  }
  const submitPrompt = async (
    runtime: BuliApplicationRuntime,
    prompt: IBuliPromptInput,
  ): Promise<void> => {
    const run = runtime.submitPrompt(prompt)
    await Promise.all([run.promptPersisted, run.runFinished])
  }

  try {
    const first = createRuntime("first")
    const second = createRuntime("second")
    await submitPrompt(first, { text: "First question" })
    await submitPrompt(second, { text: "Second question" })
    const originalView = first.openSession("first")
    const secondView = second.openSession("second")

    expect(() => second.openSession("first")).toThrow("Unable to lock session log")
    expect(second.openSession("second")).toBe(secondView)
    expect(() => first.openSession("second")).toThrow("Unable to lock session log")
    await submitPrompt(second, { sessionId: "second", text: "Still owned" })
    expect(secondView.getSnapshot().messages
      .filter((message) => message.role === "user")
      .map((message) => message.content))
      .toEqual(["Second question", "Still owned"])

    await first.closeSession("first")
    second.openSession("first")
    expect(() => first.openSession("first")).toThrow("Unable to lock session log")
    await submitPrompt(second, { sessionId: "first", text: "Added by second runtime" })
    await second.closeSession("first")

    const reopenedView = first.openSession("first")
    expect(reopenedView).not.toBe(originalView)
    expect(reopenedView.getSnapshot().messages
      .filter((message) => message.role === "user")
      .map((message) => message.content))
      .toEqual(["First question", "Added by second runtime"])
    await submitPrompt(first, { sessionId: "first", text: "Continue after reopening" })
    expect(modelRequests.at(-1)).toEqual([
      "First question",
      "Added by second runtime",
      "Continue after reopening",
    ])
  } finally {
    await Promise.all(runtimes.map((runtime) => runtime.dispose()))
    for (const manager of managers) manager.dispose()
    await rm(directoryPath, { recursive: true, force: true })
  }
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
  const promptRun = runtime.submitPrompt({
    sessionId: "session-1",
    text: "Initial prompt",
  })
  await promptRun.promptPersisted
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
      runId: promptRun.runId,
      source: "steer",
      content: "Adjust the answer",
    }),
  ])
  expect(view.getSnapshot().pendingFollowUpMessages).toEqual([
    expect.objectContaining({
      runId: promptRun.runId,
      source: "followUp",
      content: "Then summarize it",
    }),
  ])

  releaseFirst.resolve()
  await promptRun.runFinished

  expect(requests).toHaveLength(3)
  expect(requests[1]?.messages.at(-1)).toMatchObject({
    runId: promptRun.runId,
    source: "steer",
    content: "Adjust the answer",
  })
  expect(requests[2]?.messages.at(-1)).toMatchObject({
    runId: promptRun.runId,
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

test("synchronous prompt failure waits for session disposal before rollback", async () => {
  const cleanupOperations: string[] = []
  const manager = Object.assign(new InMemorySessionManager(), {
    releaseSession: (sessionId: string) => {
      cleanupOperations.push(`release:${sessionId}`)
    },
  })
  const deleteSession = manager.deleteSession
  const deletion = spyOn(manager, "deleteSession").mockImplementation((sessionId) => {
    deleteSession(sessionId)
    cleanupOperations.push(`delete:${sessionId}`)
  })
  const failure = new Error("Cannot start prompt")
  const prompt = spyOn(AgentSession.prototype, "prompt").mockImplementation(() => {
    throw failure
  })
  const stopped = Promise.withResolvers<void>()
  const originalDispose = AgentSession.prototype.dispose
  const disposal = spyOn(AgentSession.prototype, "dispose")
    .mockImplementation(async function (this: AgentSession) {
      await stopped.promise
      await originalDispose.call(this)
    })
  const runtime = runtimeWith(model, TEST_AGENTS, manager)
  let rollback: Promise<void> | undefined

  try {
    let receivedError: unknown
    try {
      runtime.submitPrompt({ text: "New session" })
    } catch (error) {
      receivedError = error
    }
    expect(receivedError).toBe(failure)
    rollback = runtime.closeSession("session-1")
    await Promise.resolve()
    expect(disposal).toHaveBeenCalledTimes(1)
    expect(cleanupOperations).toEqual([])
    expect(manager.getSessionInfo("session-1")).toBeDefined()
    expect(() => runtime.openSession("session-1")).toThrow("Session is closing")

    stopped.resolve()
    await rollback
    expect(cleanupOperations).toEqual(["delete:session-1", "release:session-1"])
    expect(manager.getSessionInfo("session-1")).toBeUndefined()
  } finally {
    stopped.resolve()
    try {
      await rollback
    } finally {
      prompt.mockRestore()
      disposal.mockRestore()
      deletion.mockRestore()
      await runtime.dispose()
    }
  }
})

test("synchronous prompt failure reports rollback failure without releasing ownership", async () => {
  const releasedSessionIds: string[] = []
  const manager = Object.assign(new InMemorySessionManager(), {
    releaseSession: (sessionId: string) => {
      releasedSessionIds.push(sessionId)
    },
  })
  const deletion = spyOn(manager, "deleteSession")
  const promptFailure = new Error("Cannot start prompt")
  const disposalFailure = new Error("Session did not stop")
  const prompt = spyOn(AgentSession.prototype, "prompt").mockImplementation(() => {
    throw promptFailure
  })
  const disposal = spyOn(AgentSession.prototype, "dispose")
    .mockRejectedValue(disposalFailure)
  const reported = Promise.withResolvers<void>()
  const logError = spyOn(console, "error").mockImplementation(() => {
    reported.resolve()
  })
  const runtime = runtimeWith(model, TEST_AGENTS, manager)

  try {
    let receivedError: unknown
    try {
      runtime.submitPrompt({ text: "New session" })
    } catch (error) {
      receivedError = error
    }
    expect(receivedError).toBe(promptFailure)
    await reported.promise
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith(
      "Session rollback failed: session-1",
      disposalFailure,
    )
    expect(deletion).not.toHaveBeenCalled()
    expect(releasedSessionIds).toEqual([])
    expect(manager.getSessionInfo("session-1")).toBeDefined()
    expect(() => runtime.openSession("session-1")).toThrow("failed to close")
  } finally {
    prompt.mockRestore()
    disposal.mockRestore()
    deletion.mockRestore()
    logError.mockRestore()
    await runtime.dispose()
  }
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

test("closing a session waits for disposal before releasing ownership", async () => {
  const releasedSessionIds: string[] = []
  const manager = Object.assign(new InMemorySessionManager(), {
    releaseSession: (sessionId: string) => {
      releasedSessionIds.push(sessionId)
    },
  })
  const runtime = runtimeWith(model, TEST_AGENTS, manager)
  const view = createSession(runtime)
  const session = view as typeof view & { dispose(): Promise<void> }
  const stopped = Promise.withResolvers<void>()
  const disposal = spyOn(session, "dispose").mockImplementation(() => stopped.promise)

  try {
    const closing = runtime.closeSession("session-1")
    expect(runtime.closeSession("session-1")).toBe(closing)
    expect(() => runtime.openSession("session-1")).toThrow("Session is closing")
    expect(() => runtime.submitPrompt({ sessionId: "session-1", text: "Hello" }))
      .toThrow("Session is closing")
    await Promise.resolve()
    expect(disposal).toHaveBeenCalledTimes(1)
    expect(releasedSessionIds).toEqual([])

    stopped.resolve()
    await closing
    expect(releasedSessionIds).toEqual(["session-1"])
    expect(manager.getSessionInfo("session-1")).toBeDefined()
    disposal.mockRestore()
    await session.dispose()
    expect(runtime.openSession("session-1")).not.toBe(view)
  } finally {
    stopped.resolve()
    disposal.mockRestore()
    await session.dispose()
    await runtime.dispose()
  }
})

test("runtime shutdown waits for an overlapping session close before disposing storage", async () => {
  const operations: string[] = []
  const manager = Object.assign(new InMemorySessionManager(), {
    releaseSession: (sessionId: string) => {
      operations.push(`release:${sessionId}`)
    },
    dispose: () => {
      operations.push("dispose-manager")
    },
  })
  const runtime = runtimeWith(model, TEST_AGENTS, manager)
  const view = createSession(runtime)
  const session = view as typeof view & { dispose(): Promise<void> }
  const disposalStarted = Promise.withResolvers<void>()
  const allowSessionStop = Promise.withResolvers<void>()
  const sessionStopped = allowSessionStop.promise.then(() => {
    operations.push("session-stopped")
  })
  const sessionDisposal = spyOn(session, "dispose").mockImplementation(() => {
    disposalStarted.resolve()
    return sessionStopped
  })
  const tasks: Promise<void>[] = []

  try {
    const closing = runtime.closeSession("session-1")
    tasks.push(closing)
    await disposalStarted.promise
    const shutdown = runtime.dispose()
    tasks.push(shutdown)
    expect(operations).toEqual([])

    allowSessionStop.resolve()
    await Promise.all([closing, shutdown])
    expect(operations).toEqual([
      "session-stopped",
      "release:session-1",
      "dispose-manager",
    ])
  } finally {
    allowSessionStop.resolve()
    await Promise.allSettled(tasks)
    sessionDisposal.mockRestore()
    await session.dispose()
    await runtime.dispose()
  }
})

test("failed session disposal retains ownership and prevents reopening", async () => {
  const releasedSessionIds: string[] = []
  const manager = Object.assign(new InMemorySessionManager(), {
    releaseSession: (sessionId: string) => {
      releasedSessionIds.push(sessionId)
    },
  })
  const runtime = runtimeWith(model, TEST_AGENTS, manager)
  const view = createSession(runtime)
  const session = view as typeof view & { dispose(): Promise<void> }
  const failure = new Error("Session did not stop")
  const disposal = spyOn(session, "dispose").mockRejectedValue(failure)

  try {
    const closing = runtime.closeSession("session-1")
    await expect(closing).rejects.toBe(failure)
    expect(runtime.closeSession("session-1")).toBe(closing)
    expect(releasedSessionIds).toEqual([])
    expect(manager.getSessionInfo("session-1")).toBeDefined()
    expect(() => runtime.openSession("session-1")).toThrow("failed to close")
  } finally {
    disposal.mockRestore()
    await runtime.dispose()
  }
})

test("runtime retains the session manager when a session fails to stop", async () => {
  let managerDisposals = 0
  const manager = Object.assign(new InMemorySessionManager(), {
    dispose: () => {
      managerDisposals += 1
    },
  })
  const runtime = runtimeWith(model, TEST_AGENTS, manager)
  const view = createSession(runtime)
  const session = view as typeof view & { dispose(): Promise<void> }
  const failure = new Error("Session did not stop")
  const sessionDisposal = spyOn(session, "dispose").mockRejectedValue(failure)

  try {
    const disposal = runtime.dispose()
    const error = await disposal.catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([failure])
    expect(managerDisposals).toBe(0)
    expect(runtime.dispose()).toBe(disposal)
    expect(sessionDisposal).toHaveBeenCalledTimes(1)
  } finally {
    sessionDisposal.mockRestore()
    await session.dispose()
    manager.dispose()
  }
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

  const promptRun = runtime.submitPrompt({
    sessionId: "stored-session",
    text: "New prompt",
  })
  await promptRun.promptPersisted
  await promptRun.runFinished
  const first = runtime.openSession("stored-session")
  const second = runtime.openSession("stored-session")

  expect(second).toBe(first)
  expect(first.getSnapshot().messages).toEqual([
    expect.objectContaining({ content: "Stored prompt", runId: "stored-run" }),
    expect.objectContaining({
      content: "New prompt",
      runId: promptRun.runId,
      source: "prompt",
    }),
    expect.objectContaining({ role: "assistant", runId: promptRun.runId }),
  ])

  await runtime.dispose()
})

test("application runtime resolves fixed prompt and tools from an agent", async () => {
  const requests: IAgentModelRequest[] = []
  const reviewTool = defineAgentTool({
    name: "review",
    description: "Review code",
    inputSchema: {},
    execute: async () => "reviewed",
  })
  const agents: readonly IAgentDefinition[] = [
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

  const promptRun = runtime.submitPrompt({
    sessionId: reviewSession.id,
    text: "Review this",
  })
  await promptRun.promptPersisted
  await promptRun.runFinished

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
        defaultReasoningEffort: "medium",
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
        defaultReasoningEffort: "medium",
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

  const firstRun = runtime.submitPrompt({
    sessionId: "session-1",
    text: "First",
  })
  await firstRun.promptPersisted
  await firstRun.runFinished
  runtime.selectModel("second")
  const modelSnapshot = runtime.getSnapshot()
  const secondRun = runtime.submitPrompt({
    sessionId: "session-1",
    text: "Second",
  })
  await secondRun.promptPersisted
  await secondRun.runFinished
  runtime.selectReasoningEffort("high")
  const thirdRun = runtime.submitPrompt({
    sessionId: "session-1",
    text: "Third",
  })
  await thirdRun.promptPersisted
  await thirdRun.runFinished

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

test("application runtime replaces models atomically and reconciles selection", async () => {
  const loadedModel: IAgentModel = {
    async *stream() {
      yield { type: "finish", reason: "stop" }
    },
  }
  const runtime = new BuliApplicationRuntime({
    workspaceRoot: WORKSPACE_ROOT,
    manager: new InMemorySessionManager(),
    agents: TEST_AGENTS,
    defaultAgentId: TEST_AGENT_ID,
    models: [{
      id: "initial",
      name: "Initial",
      model,
      reasoningEfforts: ["low"],
      defaultReasoningEffort: "low",
    }],
    selection: { modelId: "initial", reasoningEffort: "low" },
    loadModels: async () => [{
      id: "loaded",
      name: "Loaded",
      model: loadedModel,
      modelProfile: {
        providerId: "openai",
        modelId: "loaded-wire-id",
        contextWindowTokens: 200_000,
      },
      reasoningEfforts: ["high"],
      defaultReasoningEffort: "high",
    }],
    generateId: () => "session-1",
  })
  const session = createSession(runtime)
  const previous = runtime.getSnapshot()
  let notifications = 0
  runtime.subscribe(() => {
    notifications += 1
  })

  await runtime.refreshModels()

  expect(runtime.getSnapshot()).not.toBe(previous)
  expect(previous.models).toEqual([{
    id: "initial",
    name: "Initial",
    reasoningEfforts: ["low"],
  }])
  expect(runtime.getSnapshot()).toMatchObject({
    models: [{
      id: "loaded",
      name: "Loaded",
      reasoningEfforts: ["high"],
    }],
    selection: { modelId: "loaded", reasoningEffort: "high" },
  })
  expect(session.getSnapshot().contextUsage).toMatchObject({
    contextWindowTokens: 200_000,
    shouldCompact: false,
  })
  expect(Object.isFrozen(runtime.getSnapshot().models[0])).toBe(true)
  expect(Object.isFrozen(runtime.getSnapshot().models[0]?.reasoningEfforts)).toBe(true)
  expect(notifications).toBe(1)
  expect(runtime.getSnapshot()).not.toHaveProperty("modelCatalog")

  await runtime.dispose()
})

test("preferred initial models require discovery, including an empty preference list", async () => {
  expect(() => new BuliApplicationRuntime({
    workspaceRoot: WORKSPACE_ROOT,
    manager: new InMemorySessionManager(),
    agents: TEST_AGENTS,
    defaultAgentId: TEST_AGENT_ID,
    models: CATALOG_MODELS,
    selection: { modelId: "base", reasoningEffort: "medium" },
    preferredModelIds: [],
  })).toThrow("preferredModelIds requires loadModels")

  const runtime = runtimeWithPreferredModels({ preferredModelIds: [] })
  expect(runtime.getSnapshot().models).toEqual([])
  expect(runtime.getSnapshot().modelCatalog).toEqual({ status: "loading" })
  await runtime.refreshModels()
  expect(runtime.getSnapshot().selection).toEqual({
    modelId: "base",
    reasoningEffort: "high",
  })
  await runtime.dispose()
})

test("first discovery prefers Fast and its catalog default over the provisional base", async () => {
  const release = Promise.withResolvers<readonly IBuliModelRuntimeConfig[]>()
  const preferences = ["base::fast", "base"]
  const runtime = runtimeWithPreferredModels({
    preferredModelIds: preferences,
    loadModels: () => release.promise,
  })
  const initial = runtime.getSnapshot()
  const refresh = runtime.refreshModels()
  // Neither caller mutation nor failed picker validation is explicit selection.
  preferences.splice(0, preferences.length, "other")
  expect(() => runtime.selectModel("missing")).toThrow("Unknown model")
  expect(() => runtime.selectReasoningEffort("max")).toThrow("Unsupported reasoning")
  release.resolve(CATALOG_MODELS)
  await refresh

  expect(runtime.getSnapshot().selection).toEqual({
    modelId: "base::fast",
    reasoningEffort: "high",
  })
  expect(runtime.getSnapshot().modelCatalog).toEqual({ status: "ready" })
  expect(runtime.getSnapshot().models.map((entry) => entry.id)).toEqual([
    "other", "base", "base::fast",
  ])
  expect(runtime.getSnapshot().models[2]).not.toHaveProperty("model")
  expect(runtime.getSnapshot().models[2]).not.toHaveProperty("modelProfile")
  expect(runtime.getSnapshot().models[2]).not.toHaveProperty("fallbackSelectionId")
  expect(Object.isFrozen(runtime.getSnapshot().modelCatalog)).toBe(true)
  expect(initial.models).toEqual([])
  expect(initial.modelCatalog).toEqual({ status: "loading" })
  await runtime.dispose()
})

test("provisional models cannot generate or supply context limits, but sessions remain usable", async () => {
  const release = Promise.withResolvers<readonly IBuliModelRuntimeConfig[]>()
  const manager = new InMemorySessionManager()
  manager.createSession({
    id: "stored",
    agentId: TEST_AGENT_ID,
    title: "Stored session",
    createdAt: 1,
    updatedAt: 1,
  })
  for (let index = 0; index < 8; index += 1) {
    manager.appendMessage({
      id: `message-${index}`,
      sessionId: "stored",
      runId: `run-${index}`,
      role: "user",
      source: "prompt",
      content: `Historical prompt ${index} `.repeat(100),
      createdAt: index + 1,
    })
  }
  const createStoredSession = spyOn(manager, "createSession")
  const appendMessage = spyOn(manager, "appendMessage")
  let provisionalCalls = 0
  let discoveredCalls = 0
  const runtime = runtimeWithPreferredModels({
    manager,
    models: [{
      ...CATALOG_BASE,
      model: { async *stream() { provisionalCalls += 1 } },
    }],
    loadModels: () => release.promise,
  })
  const stored = runtime.openSession("stored")
  const assertBlocked = (): void => {
    expect(runtime.getSnapshot().models).toEqual([])
    expect(runtime.getSnapshot().modelCatalog).toEqual({ status: "loading" })
    expect(() => runtime.submitPrompt({ text: "New prompt" })).toThrow(
      "Model catalog is loading",
    )
    expect(() => runtime.submitPrompt({ sessionId: "stored", text: "Continue" }))
      .toThrow("Model catalog is loading")
    expect(() => runtime.compactSession("stored")).toThrow("Model catalog is loading")
    expect(stored.getSnapshot().contextUsage).not.toHaveProperty("contextWindowTokens")
    expect(stored.getSnapshot().contextUsage?.shouldCompact).toBe(false)
    expect(createStoredSession).not.toHaveBeenCalled()
    expect(appendMessage).not.toHaveBeenCalled()
    expect(manager.getCompactionCheckpoint("stored")).toBeUndefined()
    expect(provisionalCalls).toBe(0)
  }
  assertBlocked()
  const refresh = runtime.refreshModels()
  assertBlocked()
  const created = createSession(runtime)
  expect(runtime.openSession("session-1")).toBe(created)
  expect(created.getSnapshot().contextUsage).not.toHaveProperty("contextWindowTokens")
  await runtime.abort("stored")
  await runtime.abort("session-1")
  expect(runtime.listSessions()).toHaveLength(2)

  release.resolve([CATALOG_BASE, {
    ...CATALOG_FAST,
    model: {
      async *stream() {
        discoveredCalls += 1
        yield { type: "finish", reason: "stop" }
      },
    },
  }])
  await refresh
  expect(stored.getSnapshot().contextUsage?.contextWindowTokens).toBe(200_000)
  const run = runtime.submitPrompt({ sessionId: "session-1", text: "Ready prompt" })
  expect(run).not.toBeInstanceOf(Promise)
  await run.promptPersisted
  await run.runFinished
  expect(discoveredCalls).toBe(1)
  expect(provisionalCalls).toBe(0)
  createStoredSession.mockRestore()
  appendMessage.mockRestore()
  await runtime.dispose()
})

test.each([
  { models: [CATALOG_OTHER, CATALOG_BASE], selected: "base", effort: "high" },
  { models: [CATALOG_OTHER], selected: "other", effort: "medium" },
])("initial missing preferences explicitly fall back to $selected", async ({ models, selected, effort }) => {
  let registrations: readonly IBuliModelRuntimeConfig[] = models
  const runtime = runtimeWithPreferredModels({ loadModels: async () => registrations })
  await runtime.refreshModels()
  expect(runtime.getSnapshot().selection).toEqual({
    modelId: selected,
    reasoningEffort: effort,
  })
  expect(runtime.getSnapshot().modelCatalog).toEqual({
    status: "ready",
    message: `Model "base::fast" was not returned in the model catalog for your signed-in ChatGPT account. Availability may depend on your plan or account permissions. Using "${selected}" instead.`,
  })
  const fallback = runtime.getSnapshot()
  expect(() => runtime.selectModel("missing")).toThrow("Unknown model")
  expect(runtime.getSnapshot()).toBe(fallback)
  // A deliberate choice of the fallback itself dismisses the advisory notice.
  runtime.selectModel(selected)
  expect(runtime.getSnapshot().modelCatalog).toEqual({ status: "ready" })
  expect(runtime.getSnapshot()).not.toBe(fallback)
  registrations = CATALOG_MODELS
  await runtime.refreshModels()
  expect(runtime.getSnapshot().selection.modelId).toBe(selected)
  await runtime.dispose()
})

test.each([
  { modelId: "base", effort: "medium", selected: "base", selectedEffort: "medium" },
  { modelId: "other", effort: "high", selected: "other", selectedEffort: "high" },
  { modelId: "other", effort: "low", selected: "other", selectedEffort: "medium" },
  { modelId: undefined, effort: "medium", selected: "base::fast", selectedEffort: "medium" },
  { modelId: undefined, effort: "low", selected: "base::fast", selectedEffort: "high" },
  { modelId: "base", effort: undefined, selected: "base", selectedEffort: "high" },
  { modelId: "vanishing", effort: "high", selected: "base::fast", selectedEffort: "high" },
] as const)("discovery respects explicit model $modelId / effort $effort made during the request", async ({
  modelId, effort, selected, selectedEffort,
}) => {
  const release = Promise.withResolvers<readonly IBuliModelRuntimeConfig[]>()
  const runtime = runtimeWithPreferredModels({
    models: [...CATALOG_MODELS, { ...CATALOG_OTHER, id: "vanishing" }].map((entry) => ({
      ...entry,
      reasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "medium",
    })),
    loadModels: () => release.promise,
  })
  const refresh = runtime.refreshModels()
  if (modelId !== undefined) runtime.selectModel(modelId)
  if (effort !== undefined) runtime.selectReasoningEffort(effort)
  expect(runtime.getSnapshot().models).toEqual([])
  release.resolve(CATALOG_MODELS)
  await refresh
  expect(runtime.getSnapshot().selection).toEqual({
    modelId: selected,
    reasoningEffort: selectedEffort,
  })
  if (modelId === "vanishing") {
    expect(runtime.getSnapshot().modelCatalog?.message).toBe('Model "vanishing" was not returned in the model catalog for your signed-in ChatGPT account. Availability may depend on your plan or account permissions. Using "base::fast" instead.')
  } else {
    expect(runtime.getSnapshot().modelCatalog).toEqual({ status: "ready" })
  }
  await runtime.dispose()
})

test("provisional model-switch defaults do not erase an explicit reasoning choice", async () => {
  const release = Promise.withResolvers<readonly IBuliModelRuntimeConfig[]>()
  const runtime = runtimeWithPreferredModels({
    models: [CATALOG_BASE, { ...CATALOG_OTHER, reasoningEfforts: ["medium"] }],
    loadModels: () => release.promise,
  })
  const refresh = runtime.refreshModels()
  runtime.selectReasoningEffort("high")
  runtime.selectModel("other")
  expect(runtime.getSnapshot().selection.reasoningEffort).toBe("medium")
  release.resolve(CATALOG_MODELS)
  await refresh
  expect(runtime.getSnapshot().selection).toEqual({
    modelId: "other",
    reasoningEffort: "high",
  })
  await runtime.dispose()
})

test.each([
  { failure: new Error("Login required"), message: "Login required" },
  { failure: [], message: "At least one model must be registered" },
  { failure: [CATALOG_BASE, CATALOG_BASE], message: "Duplicate model: base" },
])("initial catalog failure stays blocked and retries without consuming preference: $message", async ({ failure, message }) => {
  const retry = Promise.withResolvers<readonly IBuliModelRuntimeConfig[]>()
  let loadCalls = 0
  const runtime = runtimeWithPreferredModels({
    loadModels: async () => {
      loadCalls += 1
      if (loadCalls > 1) return retry.promise
      if (failure instanceof Error) throw failure
      return failure
    },
  })
  const statuses: (string | undefined)[] = []
  runtime.subscribe(() => statuses.push(runtime.getSnapshot().modelCatalog?.status))
  await expect(runtime.refreshModels()).rejects.toThrow(message)
  expect(runtime.getSnapshot().modelCatalog?.status).toBe("error")
  expect(runtime.getSnapshot().modelCatalog?.message).toContain(message)
  expect(runtime.getSnapshot().models).toEqual([])
  expect(() => runtime.submitPrompt({ text: "Blocked" })).toThrow("Model catalog unavailable")
  expect(runtime.listSessions()).toEqual([])
  const session = createSession(runtime)
  expect(session.getSnapshot().contextUsage).not.toHaveProperty("contextWindowTokens")
  expect(() => runtime.compactSession("session-1")).toThrow("Model catalog unavailable")
  await runtime.abort("session-1")

  const refresh = runtime.refreshModels()
  expect(runtime.refreshModels()).toBe(refresh)
  expect(runtime.getSnapshot().modelCatalog).toEqual({ status: "loading" })
  retry.resolve(CATALOG_MODELS)
  await refresh
  expect(loadCalls).toBe(2)
  expect(statuses).toEqual(["loading", "error", "loading", "ready"])
  expect(runtime.getSnapshot().selection).toEqual({
    modelId: "base::fast",
    reasoningEffort: "high",
  })
  expect(session.getSnapshot().contextUsage?.contextWindowTokens).toBe(200_000)
  await runtime.dispose()
})

test("refresh errors after readiness retain an executable catalog and publish only a warning", async () => {
  let response = Promise.resolve<readonly IBuliModelRuntimeConfig[]>(CATALOG_MODELS)
  const runtime = runtimeWithPreferredModels({ loadModels: () => response })
  await runtime.refreshModels()
  const ready = runtime.getSnapshot()
  const failure = Promise.withResolvers<readonly IBuliModelRuntimeConfig[]>()
  response = failure.promise
  const refresh = runtime.refreshModels()
  expect(runtime.getSnapshot()).toBe(ready)
  const run = runtime.submitPrompt({ text: "Usable during refresh" })
  await run.runFinished
  failure.reject(new Error("Catalog offline"))
  await expect(refresh).rejects.toThrow("Catalog offline")
  expect(runtime.getSnapshot().models).toEqual(ready.models)
  expect(runtime.getSnapshot().selection).toEqual(ready.selection)
  expect(runtime.getSnapshot().modelCatalog).toEqual({
    status: "ready",
    message: "Model catalog refresh failed; using the previous catalog. Catalog offline",
  })
  const nextRun = runtime.submitPrompt({ sessionId: run.sessionId, text: "Still usable" })
  await nextRun.runFinished
  await expect(runtime.compactSession(run.sessionId)).resolves.toBeUndefined()

  response = Promise.resolve([CATALOG_BASE, CATALOG_BASE])
  await expect(runtime.refreshModels()).rejects.toThrow("Duplicate model: base")
  expect(runtime.getSnapshot().modelCatalog?.status).toBe("ready")
  expect(runtime.getSnapshot().models).toEqual(ready.models)
  expect(runtime.getSnapshot().selection).toEqual(ready.selection)
  response = Promise.resolve(CATALOG_MODELS)
  await runtime.refreshModels()
  expect(runtime.getSnapshot().modelCatalog).toEqual({ status: "ready" })
  await runtime.dispose()
})

test("later refreshes preserve selection, reconcile removed Fast to base, and do not reapply preference", async () => {
  let registrations: readonly IBuliModelRuntimeConfig[] = CATALOG_MODELS
  const runtime = runtimeWithPreferredModels({ loadModels: async () => registrations })
  await runtime.refreshModels()
  runtime.selectModel("other")
  runtime.selectReasoningEffort("medium")
  await runtime.refreshModels()
  expect(runtime.getSnapshot().selection).toEqual({
    modelId: "other",
    reasoningEffort: "medium",
  })

  runtime.selectModel("base::fast")
  registrations = [CATALOG_OTHER, CATALOG_BASE]
  await runtime.refreshModels()
  expect(runtime.getSnapshot().selection).toEqual({
    modelId: "base",
    reasoningEffort: "medium",
  })
  expect(runtime.getSnapshot().modelCatalog).toEqual({
    status: "ready",
    message: 'Model "base::fast" was not returned in the model catalog for your signed-in ChatGPT account. Availability may depend on your plan or account permissions. Using "base" instead.',
  })
  registrations = CATALOG_MODELS
  await runtime.refreshModels()
  expect(runtime.getSnapshot().selection.modelId).toBe("base")

  registrations = [CATALOG_OTHER]
  await runtime.refreshModels()
  expect(runtime.getSnapshot().selection.modelId).toBe("other")
  expect(runtime.getSnapshot().modelCatalog?.message).toBe(
    'Model "base" was not returned in the model catalog for your signed-in ChatGPT account. Availability may depend on your plan or account permissions. Using "other" instead.',
  )
  await runtime.dispose()
})

test("a discovered active run keeps its adapter, effort and context limit across refresh and follow-up", async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const calls: string[] = []
  const original: IAgentModel = {
    async *stream(request) {
      calls.push(`original:${request.reasoningEffort}`)
      started.resolve()
      await release.promise
      yield { type: "finish", reason: "stop" }
    },
  }
  const replacement: IAgentModel = {
    async *stream(request) {
      calls.push(`replacement:${request.reasoningEffort}`)
      yield { type: "finish", reason: "stop" }
    },
  }
  let fast = { ...CATALOG_FAST, model: original }
  const runtime = runtimeWithPreferredModels({
    loadModels: async () => [CATALOG_BASE, fast],
  })
  await runtime.refreshModels()
  const run = runtime.submitPrompt({ text: "First" })
  await run.promptPersisted
  await started.promise
  runtime.followUp(run.sessionId, "Follow up on the same run")
  fast = {
    ...CATALOG_FAST,
    model: replacement,
    reasoningEfforts: ["medium"],
    defaultReasoningEffort: "medium",
    modelProfile: { providerId: "test", modelId: "base", contextWindowTokens: 300_000 },
  }
  await runtime.refreshModels()
  expect(runtime.getSnapshot().selection.reasoningEffort).toBe("medium")
  const session = runtime.openSession(run.sessionId)
  expect(session.getSnapshot().contextUsage?.contextWindowTokens).toBe(200_000)
  release.resolve()
  await run.runFinished
  expect(session.getSnapshot().contextUsage?.contextWindowTokens).toBe(300_000)
  const next = runtime.submitPrompt({ sessionId: run.sessionId, text: "Next run" })
  await next.runFinished
  expect(calls).toEqual(["original:high", "original:high", "replacement:medium"])
  await runtime.dispose()
})

test.each(["abort", "dispose"] as const)("%s prevents late initial catalog registration from an uncancellable loader", async (operation) => {
  const release = Promise.withResolvers<readonly IBuliModelRuntimeConfig[]>()
  const controller = new AbortController()
  const runtime = runtimeWithPreferredModels({ loadModels: () => release.promise })
  let notifications = 0
  runtime.subscribe(() => { notifications += 1 })
  const refresh = runtime.refreshModels(controller.signal)
  // The unsignalled waiter observes when even a cancellation-ignoring loader exits.
  const shared = runtime.refreshModels()
  const loading = runtime.getSnapshot()
  if (operation === "dispose") await runtime.dispose()
  else {
    controller.abort(new Error("Discovery cancelled"))
    await expect(refresh).rejects.toThrow("Discovery cancelled")
  }
  release.resolve(CATALOG_MODELS)
  await expect(refresh).rejects.toThrow(
    operation === "dispose" ? "Buli runtime is shutting down" : "Discovery cancelled",
  )
  await expect(shared).rejects.toThrow()
  expect(runtime.getSnapshot().models).toEqual([])
  expect(runtime.getSnapshot().selection.modelId).toBe("base")
  if (operation === "dispose") {
    expect(runtime.getSnapshot()).toBe(loading)
    expect(notifications).toBe(1)
  } else {
    expect(runtime.getSnapshot().modelCatalog?.status).toBe("error")
    await runtime.refreshModels()
    expect(runtime.getSnapshot().selection.modelId).toBe("base::fast")
    await runtime.dispose()
  }
})

test("loading observers reenter the installed refresh flight and observer errors cannot break publication", async () => {
  const release = Promise.withResolvers<readonly IBuliModelRuntimeConfig[]>()
  const observerError = new Error("Observer failed")
  const logError = spyOn(console, "error").mockImplementation(() => {})
  let loadCalls = 0
  const joined: Promise<void>[] = []
  const statuses: (string | undefined)[] = []
  const runtime = runtimeWithPreferredModels({
    loadModels: () => {
      loadCalls += 1
      joined.push(runtime.refreshModels())
      return release.promise
    },
  })
  runtime.subscribe(() => {
    if (runtime.getSnapshot().modelCatalog?.status === "loading") {
      joined.push(runtime.refreshModels())
    }
    throw observerError
  })
  runtime.subscribe(() => statuses.push(runtime.getSnapshot().modelCatalog?.status))
  try {
    const refresh = runtime.refreshModels()
    expect(joined).toEqual([refresh, refresh])
    expect(loadCalls).toBe(1)
    release.resolve(CATALOG_MODELS)
    await refresh
    expect(statuses).toEqual(["loading", "ready"])
    expect(runtime.getSnapshot().modelCatalog).toEqual({ status: "ready" })
    expect(logError).toHaveBeenCalledTimes(2)
    expect(logError).toHaveBeenCalledWith("Runtime observer failed", observerError)
  } finally {
    logError.mockRestore()
    await runtime.dispose()
  }
})

test("disposal from a loading observer prevents the loader and remaining notifications", async () => {
  let loadCalls = 0
  const runtime = runtimeWithPreferredModels({
    loadModels: async () => {
      loadCalls += 1
      return CATALOG_MODELS
    },
  })
  runtime.subscribe(() => { void runtime.dispose() })
  let laterNotifications = 0
  runtime.subscribe(() => { laterNotifications += 1 })
  await expect(runtime.refreshModels()).rejects.toThrow("Buli runtime is shutting down")
  await runtime.dispose()
  expect(loadCalls).toBe(0)
  expect(laterNotifications).toBe(0)
  expect(runtime.getSnapshot().models).toEqual([])
})

test("aborting from a loading observer rejects the installed waiter without starting discovery", async () => {
  const controller = new AbortController()
  let loadCalls = 0
  const runtime = runtimeWithPreferredModels({
    loadModels: async () => {
      loadCalls += 1
      return CATALOG_MODELS
    },
  })
  runtime.subscribe(() => {
    if (runtime.getSnapshot().modelCatalog?.status === "loading") {
      controller.abort(new Error("Discovery cancelled by observer"))
    }
  })
  await expect(runtime.refreshModels(controller.signal)).rejects.toThrow(
    "Discovery cancelled by observer",
  )
  expect(loadCalls).toBe(0)
  expect(runtime.getSnapshot().modelCatalog?.status).toBe("error")
  expect(runtime.getSnapshot().models).toEqual([])
  await runtime.dispose()
})

test("model refresh falls back from a removed Fast variant to its base", async () => {
  const wireProfile = {
    providerId: "openai",
    modelId: "gpt-5.6-luna",
    contextWindowTokens: 272_000,
  }
  const runtime = new BuliApplicationRuntime({
    workspaceRoot: WORKSPACE_ROOT,
    manager: new InMemorySessionManager(),
    agents: TEST_AGENTS,
    defaultAgentId: TEST_AGENT_ID,
    models: [
      {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        model,
        modelProfile: wireProfile,
        reasoningEfforts: ["medium", "high"],
        defaultReasoningEffort: "medium",
      },
      {
        id: "gpt-5.6-luna::fast",
        name: "GPT-5.6 Luna Fast",
        model,
        modelProfile: wireProfile,
        fallbackSelectionId: "gpt-5.6-luna",
        reasoningEfforts: ["medium", "high"],
        defaultReasoningEffort: "medium",
      },
    ],
    selection: {
      modelId: "gpt-5.6-luna::fast",
      reasoningEffort: "high",
    },
    loadModels: async () => [
      {
        id: "another-model",
        name: "Another model",
        model,
        reasoningEfforts: ["low"],
        defaultReasoningEffort: "low",
      },
      {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        model,
        modelProfile: wireProfile,
        reasoningEfforts: ["medium", "high"],
        defaultReasoningEffort: "medium",
      },
    ],
  })

  expect(runtime.getSnapshot().models[1]).not.toHaveProperty(
    "fallbackSelectionId",
  )
  await runtime.refreshModels()

  expect(runtime.getSnapshot().selection).toEqual({
    modelId: "gpt-5.6-luna",
    reasoningEffort: "high",
  })
  await runtime.dispose()
})

test("application runtime validates model fallback registrations", () => {
  const createRuntime = (fallbackSelectionId: string) => () => (
    new BuliApplicationRuntime({
      workspaceRoot: WORKSPACE_ROOT,
      manager: new InMemorySessionManager(),
      agents: TEST_AGENTS,
      defaultAgentId: TEST_AGENT_ID,
      models: [
        {
          id: "base",
          name: "Base",
          model,
          reasoningEfforts: ["medium"],
          defaultReasoningEffort: "medium",
        },
        {
          id: "fast",
          name: "Fast",
          model,
          fallbackSelectionId,
          reasoningEfforts: ["medium"],
          defaultReasoningEffort: "medium",
        },
      ],
      selection: { modelId: "base", reasoningEffort: "medium" },
    })
  )

  expect(createRuntime(" ")).toThrow(
    "Model fallback selection ID cannot be empty: fast",
  )
  expect(createRuntime("fast")).toThrow(
    "Model fallback cannot reference itself: fast",
  )
  expect(createRuntime("missing")).toThrow(
    "Unknown model fallback: missing",
  )
})

test("model selection adopts the target default when efforts do not overlap", async () => {
  const runtime = new BuliApplicationRuntime({
    workspaceRoot: WORKSPACE_ROOT,
    manager: new InMemorySessionManager(),
    agents: TEST_AGENTS,
    defaultAgentId: TEST_AGENT_ID,
    models: [
      {
        id: "low-only",
        name: "Low only",
        model,
        reasoningEfforts: ["low"],
        defaultReasoningEffort: "low",
      },
      {
        id: "high-only",
        name: "High only",
        model,
        reasoningEfforts: ["high", "max"],
        defaultReasoningEffort: "high",
      },
    ],
    selection: { modelId: "low-only", reasoningEffort: "low" },
  })

  runtime.selectModel("high-only")

  expect(runtime.getSnapshot().selection).toEqual({
    modelId: "high-only",
    reasoningEffort: "high",
  })
  await runtime.dispose()
})

test("application runtime preserves models when refresh validation fails", async () => {
  const runtime = new BuliApplicationRuntime({
    workspaceRoot: WORKSPACE_ROOT,
    manager: new InMemorySessionManager(),
    agents: TEST_AGENTS,
    defaultAgentId: TEST_AGENT_ID,
    models: [{
      id: "initial",
      name: "Initial",
      model,
      reasoningEfforts: ["medium"],
      defaultReasoningEffort: "medium",
    }],
    selection: { modelId: "initial", reasoningEffort: "medium" },
    loadModels: async () => [
      {
        id: "duplicate",
        name: "First duplicate",
        model,
        reasoningEfforts: ["medium"],
        defaultReasoningEffort: "medium",
      },
      {
        id: "duplicate",
        name: "Second duplicate",
        model,
        reasoningEfforts: ["medium"],
        defaultReasoningEffort: "medium",
      },
    ],
  })
  const previous = runtime.getSnapshot()
  let notifications = 0
  runtime.subscribe(() => {
    notifications += 1
  })

  await expect(runtime.refreshModels()).rejects.toThrow(
    "Duplicate model: duplicate",
  )
  expect(runtime.getSnapshot()).toBe(previous)
  expect(notifications).toBe(0)

  await runtime.dispose()
})

test("a joined refresh caller can cancel without aborting the shared load", async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let loadCalls = 0
  const runtime = new BuliApplicationRuntime({
    workspaceRoot: WORKSPACE_ROOT,
    manager: new InMemorySessionManager(),
    agents: TEST_AGENTS,
    defaultAgentId: TEST_AGENT_ID,
    models: [{
      id: "initial",
      name: "Initial",
      model,
      reasoningEfforts: ["medium"],
      defaultReasoningEffort: "medium",
    }],
    selection: { modelId: "initial", reasoningEffort: "medium" },
    loadModels: async () => {
      loadCalls += 1
      started.resolve()
      await release.promise
      return [{
        id: "loaded",
        name: "Loaded",
        model,
        reasoningEfforts: ["high"],
        defaultReasoningEffort: "high",
      }]
    },
  })
  const first = runtime.refreshModels()
  await started.promise
  const controller = new AbortController()
  const joined = runtime.refreshModels(controller.signal)

  controller.abort(new Error("joined caller cancelled"))
  await expect(joined).rejects.toThrow("joined caller cancelled")
  expect(loadCalls).toBe(1)

  release.resolve()
  await first
  expect(runtime.getSnapshot().selection.modelId).toBe("loaded")
  await runtime.dispose()
})

test("model refresh keeps an active run on its captured adapter", async () => {
  const firstStarted = Promise.withResolvers<void>()
  const releaseFirst = Promise.withResolvers<void>()
  const runs: string[] = []
  const initialModel: IAgentModel = {
    async *stream() {
      runs.push("initial")
      firstStarted.resolve()
      await releaseFirst.promise
      yield { type: "finish", reason: "stop" }
    },
  }
  const loadedModel: IAgentModel = {
    async *stream() {
      runs.push("loaded")
      yield { type: "finish", reason: "stop" }
    },
  }
  const runtime = new BuliApplicationRuntime({
    workspaceRoot: WORKSPACE_ROOT,
    manager: new InMemorySessionManager(),
    agents: TEST_AGENTS,
    defaultAgentId: TEST_AGENT_ID,
    models: [{
      id: "initial",
      name: "Initial",
      model: initialModel,
      modelProfile: {
        providerId: "test",
        modelId: "initial",
        contextWindowTokens: 1_000,
      },
      reasoningEfforts: ["medium"],
      defaultReasoningEffort: "medium",
    }],
    selection: { modelId: "initial", reasoningEffort: "medium" },
    loadModels: async () => [{
      id: "loaded",
      name: "Loaded",
      model: loadedModel,
      modelProfile: {
        providerId: "test",
        modelId: "loaded",
        contextWindowTokens: 200_000,
      },
      reasoningEfforts: ["high"],
      defaultReasoningEffort: "high",
    }],
    generateId: () => "session-1",
  })
  createSession(runtime)
  const firstRun = runtime.submitPrompt({
    sessionId: "session-1",
    text: "First",
  })
  await firstRun.promptPersisted
  await firstStarted.promise

  await runtime.refreshModels()
  expect(runtime.openSession("session-1").getSnapshot().contextUsage)
    .toMatchObject({ contextWindowTokens: 1_000 })
  releaseFirst.resolve()
  await firstRun.runFinished
  expect(runtime.openSession("session-1").getSnapshot().contextUsage)
    .toMatchObject({ contextWindowTokens: 200_000 })
  const secondRun = runtime.submitPrompt({
    sessionId: "session-1",
    text: "Second",
  })
  await secondRun.promptPersisted
  await secondRun.runFinished

  expect(runs).toEqual(["initial", "loaded"])
  expect(runtime.getSnapshot().selection).toEqual({
    modelId: "loaded",
    reasoningEffort: "high",
  })

  await runtime.dispose()
})

test("runtime disposal aborts a model refresh before it can commit", async () => {
  const started = Promise.withResolvers<void>()
  const runtime = new BuliApplicationRuntime({
    workspaceRoot: WORKSPACE_ROOT,
    manager: new InMemorySessionManager(),
    agents: TEST_AGENTS,
    defaultAgentId: TEST_AGENT_ID,
    models: [{
      id: "initial",
      name: "Initial",
      model,
      reasoningEfforts: ["medium"],
      defaultReasoningEffort: "medium",
    }],
    selection: { modelId: "initial", reasoningEffort: "medium" },
    loadModels: async (signal) => {
      started.resolve()
      const aborted = Promise.withResolvers<void>()
      const rejectOnAbort = (): void => aborted.reject(signal.reason)
      signal.addEventListener("abort", rejectOnAbort, { once: true })
      if (signal.aborted) rejectOnAbort()
      await aborted.promise
      return []
    },
  })
  const previous = runtime.getSnapshot()
  const refresh = runtime.refreshModels()
  await started.promise

  const disposal = runtime.dispose()
  await expect(refresh).rejects.toThrow(
    "Buli runtime is shutting down",
  )
  await disposal

  expect(runtime.getSnapshot()).toBe(previous)
})

test("runtime disposal does not wait for a model loader that ignores cancellation", async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const runtime = new BuliApplicationRuntime({
    workspaceRoot: WORKSPACE_ROOT,
    manager: new InMemorySessionManager(),
    agents: TEST_AGENTS,
    defaultAgentId: TEST_AGENT_ID,
    models: [{
      id: "initial",
      name: "Initial",
      model,
      reasoningEfforts: ["medium"],
      defaultReasoningEffort: "medium",
    }],
    selection: { modelId: "initial", reasoningEffort: "medium" },
    loadModels: async () => {
      started.resolve()
      await release.promise
      return [{
        id: "late",
        name: "Late",
        model,
        reasoningEfforts: ["high"],
        defaultReasoningEffort: "high",
      }]
    },
  })
  const previous = runtime.getSnapshot()
  const refresh = runtime.refreshModels()
  await started.promise

  const disposal = runtime.dispose()
  const disposedPromptly = await Promise.race([
    disposal.then(() => true),
    Bun.sleep(50).then(() => false),
  ])
  release.resolve()
  await disposal
  await expect(refresh).rejects.toThrow("Buli runtime is shutting down")

  expect(disposedPromptly).toBe(true)
  expect(runtime.getSnapshot()).toBe(previous)
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

  const promptRun = runtime.submitPrompt({ text: "  New\n session  " })

  expect(promptRun.sessionId).toBe("session-1")
  expect(runtime.listSessions()).toEqual([{
    id: "session-1",
    agentId: TEST_AGENT_ID,
    title: "New session",
    createdAt: 101,
    updatedAt: 101,
  }])

  await promptRun.promptPersisted
  await promptRun.runFinished
  expect(runtime.openSession(promptRun.sessionId).getSnapshot().messages[0])
    .toMatchObject({
      role: "user",
      source: "prompt",
      runId: promptRun.runId,
      content: "  New\n session  ",
    })

  await runtime.dispose()
})

test("submitPrompt rolls back a new session when its first prompt is not persisted", async () => {
  const memory = new InMemorySessionManager()
  const persistenceFailure = new Error("Disk write failed")
  const deletedSessionIds: string[] = []
  const cleanupOperations: string[] = []
  const manager: ISessionManager = {
    createSession: memory.createSession,
    getSessionInfo: memory.getSessionInfo,
    listSessions: memory.listSessions,
    getMessages: memory.getMessages,
    appendMessage: () => {
      throw persistenceFailure
    },
    getPresentationRevision: memory.getPresentationRevision,
    getFileChangeProposals: memory.getFileChangeProposals,
    getCompactionCheckpoint: memory.getCompactionCheckpoint,
    saveCompactionCheckpoint: memory.saveCompactionCheckpoint,
    deleteSession: (sessionId) => {
      deletedSessionIds.push(sessionId)
      memory.deleteSession(sessionId)
      cleanupOperations.push(`delete:${sessionId}`)
    },
    releaseSession: (sessionId) => {
      cleanupOperations.push(`release:${sessionId}`)
    },
  }
  const runtime = runtimeWith(model, TEST_AGENTS, manager)

  const promptRun = runtime.submitPrompt({ text: "New session" })
  const persistenceResult = promptRun.promptPersisted.then(
    () => undefined,
    (error: unknown) => error,
  )
  const runResult = promptRun.runFinished.then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(manager.getSessionInfo(promptRun.sessionId)).toBeDefined()

  expect(await persistenceResult).toBe(persistenceFailure)
  expect(await runResult).toBe(persistenceFailure)
  expect(deletedSessionIds).toEqual([promptRun.sessionId])
  expect(cleanupOperations).toEqual([
    `delete:${promptRun.sessionId}`,
    `release:${promptRun.sessionId}`,
  ])
  expect(runtime.listSessions()).toEqual([])
  expect(manager.listSessions()).toEqual([])
  expect(manager.getSessionInfo(promptRun.sessionId)).toBeUndefined()
  expect(manager.getMessages(promptRun.sessionId)).toEqual([])
  expect(() => runtime.openSession(promptRun.sessionId)).toThrow(
    `Session does not exist: ${promptRun.sessionId}`,
  )

  await runtime.dispose()
})

test("failed rollback disposal preserves the conversation and ownership", async () => {
  const releasedSessionIds: string[] = []
  const manager = Object.assign(new InMemorySessionManager(), {
    releaseSession: (sessionId: string) => {
      releasedSessionIds.push(sessionId)
    },
  })
  const persistenceFailure = new Error("Disk write failed")
  const disposalFailure = new Error("Session did not stop")
  const appendMessage = spyOn(manager, "appendMessage").mockImplementation(() => {
    throw persistenceFailure
  })
  const deleteSession = spyOn(manager, "deleteSession")
  const sessionDisposal = spyOn(AgentSession.prototype, "dispose")
    .mockRejectedValue(disposalFailure)
  const runtime = runtimeWith(model, TEST_AGENTS, manager)

  try {
    const run = runtime.submitPrompt({ text: "New session" })
    const results = await Promise.allSettled([
      run.promptPersisted,
      run.runFinished,
    ])
    for (const result of results) {
      expect(result.status).toBe("rejected")
      if (result.status !== "rejected") {
        throw new Error("Expected the prompt to fail")
      }
      expect(result.reason).toBeInstanceOf(AggregateError)
      expect((result.reason as AggregateError).errors).toEqual([
        persistenceFailure,
        disposalFailure,
      ])
    }
    expect(sessionDisposal).toHaveBeenCalledTimes(1)
    expect(deleteSession).not.toHaveBeenCalled()
    expect(releasedSessionIds).toEqual([])
    expect(manager.getSessionInfo(run.sessionId)).toBeDefined()
    expect(() => runtime.openSession(run.sessionId)).toThrow("failed to close")
  } finally {
    sessionDisposal.mockRestore()
    appendMessage.mockRestore()
    deleteSession.mockRestore()
    await runtime.dispose()
  }
})

test("new-session runFinished waits for rollback before exposing failure", async () => {
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
    getPresentationRevision: memory.getPresentationRevision,
    getFileChangeProposals: memory.getFileChangeProposals,
    getCompactionCheckpoint: memory.getCompactionCheckpoint,
    saveCompactionCheckpoint: memory.saveCompactionCheckpoint,
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

  const promptRun = runtime.submitPrompt({ text: "New session" })
  let runFinishedObserved = false
  const runResult = promptRun.runFinished.then(
    () => {
      runFinishedObserved = true
      return undefined
    },
    (error: unknown) => {
      runFinishedObserved = true
      return error
    },
  )

  await rollbackStarted.promise
  expect(runFinishedObserved).toBe(false)
  expect(runtime.listSessions().map((session) => session.id)).toEqual([
    promptRun.sessionId,
  ])

  releaseRollback.resolve()

  expect(await runResult).toBe(persistenceFailure)
  expect(runtime.listSessions()).toEqual([])
  expect(manager.getSessionInfo(promptRun.sessionId)).toBeUndefined()
  expect(() => runtime.openSession(promptRun.sessionId)).toThrow(
    `Session does not exist: ${promptRun.sessionId}`,
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

test("treats slash input as prompts", async () => {
  let interactionCount = 0
  const runtime = runtimeWith({
      async *stream() {
        interactionCount += 1
        yield { type: "finish", reason: "stop" }
      },
  })
  const view = createSession(runtime)

  const slashRun = runtime.submitPrompt({
    sessionId: "session-1",
    text: "/not-a-runtime-command",
  })
  await slashRun.promptPersisted
  await slashRun.runFinished

  expect(interactionCount).toBe(1)
  expect(view.getSnapshot().messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
  ])

  await runtime.dispose()
})
