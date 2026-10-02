import { expect, test } from "bun:test"

import {
  Agent,
  defineAgentTool,
  type TAgentEvent,
  type IAgentModel,
  type IAgentModelRequest,
  type IAgentOptions,
  type TAgentMessage,
} from "@/agent"
import { AgentWorkingContext } from "@/sessions/agent-working-context"

test("Agent.prompt returns a synchronous handle and publishes only after context acceptance", async () => {
  const { agent, owner } = createAgentFixture({
    sessionId: "session-1",
    systemPrompt: "System",
    resolveRunConfiguration: () => ({
      model: completedModel(),
      reasoningEffort: "medium",
    }),
    tools: [],
  })
  let stateObservedDuringMessageEnd = false
  agent.subscribe(async (event) => {
    if (event.type !== "message_end" || event.message.role !== "assistant") {
      return
    }
    stateObservedDuringMessageEnd = owner.getContext().messages.at(-1)?.id
      === event.message.id
  })

  const run = agent.prompt("Question")

  expect(agent.state.isRunning).toBe(true)
  expect(agent.state.activeRunId).toBe(run.runId)
  expect(run.initialPromptProcessed).toBeInstanceOf(Promise)
  expect(run.runFinished).toBeInstanceOf(Promise)

  await run.initialPromptProcessed
  await run.runFinished

  expect(stateObservedDuringMessageEnd).toBe(true)
  expect(agent.state.isRunning).toBe(false)
  expect(owner.getContext().messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
  ])
  expect(owner.getContext().messages[0]).toMatchObject({
    runId: run.runId,
    role: "user",
    source: "prompt",
    content: "Question",
  })
  expect(owner.getContext().messages[1]).toMatchObject({
    runId: run.runId,
    role: "assistant",
  })
})

test("initial prompt processing finishes after the critical sink handles the user message_end", async () => {
  const sinkEntered = Promise.withResolvers<void>()
  const releaseSink = Promise.withResolvers<void>()
  let sinkHandled = false
  const { agent, owner } = createAgentFixture({
    sessionId: "session-1",
    systemPrompt: "System",
    resolveRunConfiguration: () => ({
      model: completedModel(),
      reasoningEffort: "medium",
    }),
    tools: [],
    criticalEventSink: async (event) => {
      if (event.type !== "message_end" || event.message.role !== "user") return
      sinkEntered.resolve()
      await releaseSink.promise
      sinkHandled = true
    },
  })

  const run = agent.prompt("Question")
  let initialPromptProcessed = false
  void run.initialPromptProcessed.then(() => {
    initialPromptProcessed = true
  })
  await sinkEntered.promise

  expect(initialPromptProcessed).toBe(false)
  expect(owner.getContext().messages).toEqual([])
  expect(owner.getContext().messages).toEqual([])

  releaseSink.resolve()
  await run.initialPromptProcessed

  expect(sinkHandled).toBe(true)
  expect(owner.getContext().messages[0]).toMatchObject({ source: "prompt", content: "Question" })
  expect(owner.getContext().messages[0]).toMatchObject({
    runId: run.runId,
    role: "user",
    source: "prompt",
    content: "Question",
  })

  await run.runFinished
})

test("critical sink failure rejects initial prompt processing and run completion without adding the user message", async () => {
  const sinkFailure = new Error("Failed to persist prompt")
  const { agent, owner } = createAgentFixture({
    sessionId: "session-1",
    systemPrompt: "System",
    resolveRunConfiguration: () => ({
      model: completedModel(),
      reasoningEffort: "medium",
    }),
    tools: [],
    criticalEventSink: (event) => {
      if (event.type === "message_end" && event.message.role === "user") {
        throw sinkFailure
      }
    },
  })

  const run = agent.prompt("Question")
  const initialPromptFailure = run.initialPromptProcessed.then(
    () => undefined,
    (error: unknown) => error,
  )
  const runFailure = run.runFinished.then(
    () => undefined,
    (error: unknown) => error,
  )

  expect(await initialPromptFailure).toBe(sinkFailure)
  expect(await runFailure).toBe(sinkFailure)

  expect(owner.getContext().messages).toEqual([])
  expect(agent.state.isRunning).toBe(false)
})

test("critical sink throwing undefined rejects initial prompt processing and run completion", async () => {
  const { agent, owner } = createAgentFixture({
    sessionId: "session-1",
    systemPrompt: "System",
    resolveRunConfiguration: () => ({
      model: completedModel(),
      reasoningEffort: "medium",
    }),
    tools: [],
    criticalEventSink: (event) => {
      if (event.type === "message_end" && event.message.role === "user") {
        throw undefined
      }
    },
  })

  const run = agent.prompt("Question")
  const idle = agent.waitForIdle()
  const aborted = agent.abort()
  const [initialPrompt, runFinished, idleResult, abortResult] = await Promise.allSettled([
    run.initialPromptProcessed,
    run.runFinished,
    idle,
    aborted,
  ])

  expect(initialPrompt.status).toBe("rejected")
  expect(runFinished.status).toBe("rejected")
  expect(idleResult.status).toBe("rejected")
  expect(abortResult.status).toBe("rejected")
  expect(agent.state.isRunning).toBe(false)
  expect(agent.state.lastRunReason).toBe("internal-error")
  expect(owner.getContext().messages).toEqual([])
})

test("public observer exceptions do not fail the run", async () => {
  const observerFailure = new Error("Observer failed")
  const observerErrors: unknown[] = []
  const { agent, owner } = createAgentFixture({
    sessionId: "session-1",
    systemPrompt: "System",
    resolveRunConfiguration: () => ({
      model: completedModel(),
      reasoningEffort: "medium",
    }),
    tools: [],
    onObserverError: (error) => {
      observerErrors.push(error)
    },
  })
  agent.subscribe(async (event) => {
    if (event.type === "message_end" && event.message.role === "user") {
      throw observerFailure
    }
  })

  const run = agent.prompt("Question")
  await run.initialPromptProcessed
  await run.runFinished

  expect(observerErrors).toEqual([observerFailure])
  expect(owner.getContext().messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
  ])
  expect(agent.state.lastRunReason).toBe("completed")
})

test("agent_settled appears exactly once and all events carry the runId", async () => {
  const events: TAgentEvent[] = []
  const { agent } = createAgentFixture({
    sessionId: "session-1",
    systemPrompt: "System",
    resolveRunConfiguration: () => ({
      model: completedModel(),
      reasoningEffort: "medium",
    }),
    tools: [],
  })
  agent.subscribe((event) => {
    events.push(structuredClone(event))
  })

  const run = agent.prompt("Question")
  await run.runFinished

  expect(events.every((event) => event.runId === run.runId)).toBe(true)
  expect(events.filter((event) => event.type === "agent_settled")).toEqual([
    {
      type: "agent_settled",
      runId: run.runId,
      reason: "completed",
    },
  ])
  expect(events.at(-1)?.type).toBe("agent_settled")
})

test("agent_settled observers can start a new run immediately", async () => {
  const { agent, owner } = createAgentFixture({
    sessionId: "session-1",
    systemPrompt: "System",
    resolveRunConfiguration: () => ({
      model: completedModel(),
      reasoningEffort: "medium",
    }),
    tools: [],
  })
  let continuation: ReturnType<Agent["prompt"]> | undefined
  agent.subscribe((event) => {
    if (event.type === "agent_settled" && !continuation) {
      expect(agent.state.isRunning).toBe(false)
      continuation = agent.prompt("Second")
    }
  })

  const first = agent.prompt("First")
  const idle = agent.waitForIdle()
  await first.runFinished
  await idle
  await continuation?.runFinished

  expect(owner.getContext().messages.filter((message) => message.role === "user"))
    .toHaveLength(2)
  expect(agent.state.isRunning).toBe(false)
})

test("Agent delivers queued steering FIFO one message per response", async () => {
  const firstStarted = Promise.withResolvers<void>()
  const secondStarted = Promise.withResolvers<void>()
  const releaseFirst = Promise.withResolvers<void>()
  const releaseSecond = Promise.withResolvers<void>()
  const requests: IAgentModelRequest[] = []
  const model: IAgentModel = {
    async *stream(request) {
      const index = requests.length
      requests.push({
        ...request,
        messages: structuredClone(request.messages),
        tools: structuredClone(request.tools),
      })
      if (index === 0) {
        firstStarted.resolve()
        await releaseFirst.promise
      }
      if (index === 1) {
        secondStarted.resolve()
        await releaseSecond.promise
      }
      yield { type: "finish", reason: "stop" }
    },
  }
  const { agent, owner } = createAgentFixture({
    sessionId: "session-1",
    systemPrompt: "System",
    resolveRunConfiguration: () => ({
      model,
      reasoningEffort: "medium",
    }),
    tools: [],
  })

  expect(() => agent.steer("Too early")).toThrow(
    "Agent is not accepting steering messages",
  )

  const run = agent.prompt("Initial prompt")
  await run.initialPromptProcessed
  await firstStarted.promise
  agent.steer("First steering")
  agent.steer("Second steering")

  expect(agent.pendingSteeringMessages.map((message) => message.content)).toEqual([
    "First steering",
    "Second steering",
  ])

  releaseFirst.resolve()
  await secondStarted.promise

  expect(requests[1]?.messages.at(-1)).toMatchObject({
    runId: run.runId,
    role: "user",
    source: "steer",
    content: "First steering",
  })
  expect(requests[1]?.messages).not.toContainEqual(
    expect.objectContaining({ content: "Second steering" }),
  )
  expect(agent.pendingSteeringMessages.map((message) => message.content)).toEqual([
    "Second steering",
  ])

  releaseSecond.resolve()
  await run.runFinished

  expect(requests).toHaveLength(3)
  expect(requests[2]?.messages.at(-1)).toMatchObject({
    runId: run.runId,
    role: "user",
    source: "steer",
    content: "Second steering",
  })
  expect(agent.pendingSteeringMessages).toEqual([])
  expect(owner.getContext().messages.filter((message) => message.role === "user").map(
    (message) => message.source,
  )).toEqual(["prompt", "steer", "steer"])
})

test("Agent delivers follow-ups FIFO only after it would otherwise stop", async () => {
  const firstStarted = Promise.withResolvers<void>()
  const releaseFirst = Promise.withResolvers<void>()
  const requests: IAgentModelRequest[] = []
  const { agent, owner } = createAgentFixture({
    sessionId: "session-1",
    systemPrompt: "System",
    resolveRunConfiguration: () => ({
      model: {
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
      },
      reasoningEffort: "medium",
    }),
    tools: [],
  })

  expect(() => agent.followUp("Too early")).toThrow(
    "Agent is not accepting follow-up messages",
  )

  const run = agent.prompt("Initial prompt")
  await run.initialPromptProcessed
  await firstStarted.promise
  agent.followUp("First follow-up")
  agent.followUp("Second follow-up")

  expect(agent.pendingFollowUpMessages.map((message) => message.content)).toEqual([
    "First follow-up",
    "Second follow-up",
  ])

  releaseFirst.resolve()
  await run.runFinished

  expect(requests).toHaveLength(3)
  expect(requests[1]?.messages.at(-1)).toMatchObject({
    runId: run.runId,
    source: "followUp",
    content: "First follow-up",
  })
  expect(requests[1]?.messages).not.toContainEqual(
    expect.objectContaining({ content: "Second follow-up" }),
  )
  expect(requests[2]?.messages.at(-1)).toMatchObject({
    runId: run.runId,
    source: "followUp",
    content: "Second follow-up",
  })
  expect(agent.pendingFollowUpMessages).toEqual([])
  expect(owner.getContext().messages.filter((message) => message.role === "user").map(
    (message) => message.source,
  )).toEqual(["prompt", "followUp", "followUp"])
})

test("Agent rejects steering until the initial prompt is durable", async () => {
  const promptPersistenceStarted = Promise.withResolvers<void>()
  const releasePromptPersistence = Promise.withResolvers<void>()
  const firstRequestStarted = Promise.withResolvers<void>()
  const releaseFirstRequest = Promise.withResolvers<void>()
  const requests: IAgentModelRequest[] = []
  const { agent } = createAgentFixture({
    sessionId: "session-1",
    systemPrompt: "System",
    resolveRunConfiguration: () => ({
      model: {
        async *stream(request) {
          requests.push({
            ...request,
            messages: structuredClone(request.messages),
            tools: structuredClone(request.tools),
          })
          if (requests.length === 1) {
            firstRequestStarted.resolve()
            await releaseFirstRequest.promise
          }
          yield { type: "finish", reason: "stop" }
        },
      },
      reasoningEffort: "medium",
    }),
    tools: [],
    criticalEventSink: async (event) => {
      if (
        event.type === "message_end"
        && event.message.role === "user"
        && event.message.source === "prompt"
      ) {
        promptPersistenceStarted.resolve()
        await releasePromptPersistence.promise
      }
    },
  })

  const run = agent.prompt("Initial prompt")
  await promptPersistenceStarted.promise
  expect(() => agent.steer("Too early")).toThrow(
    "Agent is not accepting steering messages",
  )
  releasePromptPersistence.resolve()
  await run.initialPromptProcessed
  await firstRequestStarted.promise
  agent.steer("Include this next")
  releaseFirstRequest.resolve()
  await run.runFinished

  expect(requests).toHaveLength(2)
  expect(requests[0]?.messages.map((message) =>
    message.role === "user" ? message.source : message.role
  )).toEqual(["prompt"])
  expect(requests[1]?.messages.at(-1)).toMatchObject({
    runId: run.runId,
    source: "steer",
    content: "Include this next",
  })
})

test("Agent rejects overlap, abort settles the active run, and can reset when idle", async () => {
  const started = Promise.withResolvers<void>()
  const model: IAgentModel = {
    async *stream(request) {
      started.resolve()
      await new Promise<void>((resolve) => {
        if (request.signal.aborted) return resolve()
        request.signal.addEventListener("abort", () => resolve(), { once: true })
      })
      yield { type: "abort", reason: "Stopped" }
    },
  }
  const { agent, owner } = createAgentFixture({
    sessionId: "session-1",
    systemPrompt: "System",
    resolveRunConfiguration: () => ({
      model,
      reasoningEffort: "medium",
    }),
    tools: [],
  })
  const first = agent.prompt("First")
  await first.initialPromptProcessed
  await started.promise

  expect(() => agent.prompt("Second")).toThrow(
    "Agent is already processing a prompt",
  )
  expect(() => agent.reset()).toThrow("Cannot reset while Agent is running")

  await Promise.all([agent.abort(), first.runFinished])

  expect(agent.state.isRunning).toBe(false)
  expect(agent.state.lastRunReason).toBe("aborted")

  const acceptedContext = owner.getContext()
  agent.reset()

  expect(owner.getContext()).toBe(acceptedContext)
  expect("messages" in agent.state).toBe(false)
  await expect(agent.abort()).resolves.toBeUndefined()
})

test("selected path capabilities preceding the working context reach only opted-in tools", async () => {
  const received: unknown[] = []
  const ordinary: unknown[] = []
  const selectedTool = defineAgentTool({
    name: "selected_read",
    description: "Read selected paths",
    inputSchema: { type: "object", additionalProperties: false },
    acceptsSelectedPathReferences: true,
    async execute(_input, context) {
      received.push(context.selectedPathReferences)
      return "selected"
    },
  })
  const ordinaryTool = defineAgentTool({
    name: "ordinary",
    description: "Ordinary tool",
    inputSchema: { type: "object", additionalProperties: false },
    async execute(_input, context) {
      ordinary.push(context.selectedPathReferences)
      return "ordinary"
    },
  })
  let turn = 0
  const model: IAgentModel = {
    async *stream() {
      if (turn++ === 0) {
        yield {
          type: "tool-call",
          toolCallId: "selected-call",
          toolName: selectedTool.name,
          input: {},
        }
        yield {
          type: "tool-call",
          toolCallId: "ordinary-call",
          toolName: ordinaryTool.name,
          input: {},
        }
        yield { type: "finish", reason: "tool-calls" }
        return
      }
      yield { type: "finish", reason: "stop" }
    },
  }
  const previousReference = pathReference("/outside/previous.ts")
  const currentReference = pathReference("/outside/current.ts")
  let selectedPathReads = 0
  const { agent } = createAgentFixture({
    sessionId: "session-1",
    systemPrompt: "System",
    resolveRunConfiguration: () => ({ model, reasoningEffort: "medium" }),
    tools: [selectedTool, ordinaryTool],
    getSelectedPathReferences: () => { selectedPathReads++; return [previousReference] },
  })

  await agent.prompt({
    text: "@path current",
    references: [currentReference],
  }).runFinished

  expect(received).toEqual([[previousReference, currentReference]])
  expect(ordinary).toEqual([undefined])
  expect(turn).toBe(2)
  expect(selectedPathReads).toBe(1)
})

test("selected path capability limit retains the newest prompt", async () => {
  const received: unknown[] = []
  const selectedTool = defineAgentTool({
    name: "selected_read",
    description: "Read selected paths",
    inputSchema: { type: "object", additionalProperties: false },
    acceptsSelectedPathReferences: true,
    async execute(_input, context) {
      received.push(context.selectedPathReferences)
      return "selected"
    },
  })
  let turn = 0
  const model: IAgentModel = {
    async *stream() {
      if (turn++ === 0) {
        yield {
          type: "tool-call",
          toolCallId: "selected-call",
          toolName: selectedTool.name,
          input: {},
        }
        yield { type: "finish", reason: "tool-calls" }
        return
      }
      yield { type: "finish", reason: "stop" }
    },
  }
  const initialMessages = Array.from({ length: 500 }, (_, index) => ({
    id: `previous-${index}`,
    sessionId: "session-1",
    runId: `previous-run-${index}`,
    role: "user" as const,
    source: "prompt" as const,
    content: "@path",
    references: [pathReference(`/outside/previous-${index}.ts`)],
    createdAt: index,
  }))
  const { agent } = createAgentFixture({
    sessionId: "session-1",
    systemPrompt: "System",
    resolveRunConfiguration: () => ({ model, reasoningEffort: "medium" }),
    tools: [selectedTool],
    initialMessages,
    getSelectedPathReferences: () => initialMessages.flatMap((message) => message.references),
  })

  await agent.prompt({
    text: "@path",
    references: [pathReference("/outside/current.ts")],
  }).runFinished

  const references = received[0] as Array<{ readonly path: string }>
  expect(references).toHaveLength(500)
  expect(references.some(({ path }) => path === "/outside/previous-0.ts")).toBe(false)
  expect(references.at(-1)?.path).toBe("/outside/current.ts")
})

test("external context replacement and tool configuration reach the next run", async () => {
  const requests: IAgentModelRequest[] = []
  const executed: string[] = []
  const makeTool = (name: string) => defineAgentTool({
    name,
    description: name,
    inputSchema: { type: "object", additionalProperties: false },
    async execute() {
      executed.push(name)
      return name
    },
  })
  const oldTool = makeTool("old_tool")
  const newTool = makeTool("new_tool")
  const model: IAgentModel = {
    async *stream(request) {
      requests.push({
        ...request,
        messages: structuredClone(request.messages),
        tools: structuredClone(request.tools),
      })
      if (requests.length === 1) {
        yield { type: "tool-call", toolCallId: "old-call", toolName: oldTool.name, input: {} }
        yield { type: "tool-call", toolCallId: "new-call", toolName: newTool.name, input: {} }
        yield { type: "finish", reason: "tool-calls" }
        return
      }
      yield { type: "finish", reason: "stop" }
    },
  }
  const messages = [{
    id: "inherited", sessionId: "session-1", runId: "previous-run",
    role: "user" as const, source: "prompt" as const,
    content: "Inherited history", createdAt: 1,
  }]
  const { agent, owner } = createAgentFixture({
    sessionId: "session-1",
    systemPrompt: "System",
    resolveRunConfiguration: () => ({ model, reasoningEffort: "medium" }),
    tools: [oldTool],
    initialMessages: [{ ...messages[0]!, id: "old", content: "Old history" }],
  })
  const tools = [newTool]
  owner.replaceContext({ messages })
  agent.replaceContext(tools)

  expect(owner.getContext().messages).toEqual(messages)
  expect(owner.getContext().messages).not.toBe(messages)
  expect(agent.state.tools).toEqual([newTool])
  messages[0]!.content = "Changed outside Agent"
  tools.length = 0
  expect(requests).toHaveLength(0)

  await agent.prompt("Next question").runFinished

  expect(requests[0]?.messages[0]).toMatchObject({ content: "Inherited history" })
  expect(requests[0]?.messages).not.toContainEqual(
    expect.objectContaining({ content: "Old history" }),
  )
  expect(requests.every((request) =>
    request.tools.length === 1 && request.tools[0]?.name === newTool.name
  )).toBe(true)
  expect(executed).toEqual([newTool.name])
})

for (const queue of ["steer", "followUp"] as const) {
  test(`replaceContext rejects active runs and pending ${queue} without changing state`, async () => {
    const started = Promise.withResolvers<void>()
    const { agent } = createAgentFixture({
      sessionId: "session-1",
      systemPrompt: "System",
      resolveRunConfiguration: () => ({
        model: {
          async *stream(request) {
            started.resolve()
            await new Promise<void>((resolve) => {
              if (request.signal.aborted) return resolve()
              request.signal.addEventListener("abort", () => resolve(), { once: true })
            })
            yield { type: "abort", reason: "Stopped" }
          },
        },
        reasoningEffort: "medium",
      }),
      tools: [],
    })
    const run = agent.prompt("Question")
    await run.initialPromptProcessed
    await started.promise
    const runningState = agent.state
    expect(() => agent.replaceContext([])).toThrow(
      "Cannot replace context while Agent is running",
    )
    expect(agent.state).toBe(runningState)
    agent[queue]("Keep this input")
    await Promise.all([agent.abort(), run.runFinished])

    const idleState = agent.state
    const revision = agent.queuedMessagesRevision
    expect(() => agent.replaceContext([])).toThrow(
      "Restore queued messages before replacing context",
    )
    expect(agent.state).toBe(idleState)
    expect(agent.queuedMessagesRevision).toBe(revision)
    const queued = queue === "steer"
      ? agent.pendingSteeringMessages : agent.pendingFollowUpMessages
    expect(queued.map((message) => message.content)).toEqual(["Keep this input"])

    agent.clearQueuedMessages()
    agent.replaceContext([])
    expect(agent.state).toMatchObject({
      tools: [], isRunning: false,
      activeRunId: undefined, streamingMessage: undefined,
      errorMessage: undefined, lastRunReason: undefined,
    })
    expect(agent.state.pendingToolCallIds.size).toBe(0)
  })
}

test("working-context preparation preserves both previous views when cloning fails", () => {
  const { agent, owner } = createAgentFixture({
    sessionId: "session-1",
    systemPrompt: "System",
    resolveRunConfiguration: () => ({ model: completedModel(), reasoningEffort: "medium" }),
    tools: [],
  })
  const previousState = agent.state
  const previousContext = owner.getContext()
  const messages = [{
    id: "invalid", sessionId: "session-1", runId: "previous-run",
    role: "user" as const, source: "prompt" as const,
    content: "History", createdAt: 1,
    nonCloneable: () => undefined,
  }]

  expect(() => owner.replaceContext({ messages })).toThrow()
  expect(owner.getContext()).toBe(previousContext)
  expect(agent.state).toBe(previousState)
})

test("Agent requests include all external accepted context without a presentation archive", async () => {
  const requests: IAgentModelRequest[] = []
  const history = Array.from({ length: 1_050 }, (_, index) => ({
    id: `history-${index}`, sessionId: "session-1", runId: "prior-run", createdAt: index,
    role: "user" as const, source: "prompt" as const, content: `Required history ${index}`,
  }))
  const owner = new AgentWorkingContext({ messages: history, contextSummary: "Complete summary 🐂".repeat(2_000) })
  const agent = new Agent({
    sessionId: "session-1", systemPrompt: "System", tools: [],
    getContext: owner.getContext,
    getRecentConversation: () => owner.getContext().messages,
    getSelectedPathReferences: () => [],
    criticalEventSink: (event) => {
      if (event.type === "message_end") owner.acceptCommittedMessage(event.message)
    },
    resolveRunConfiguration: () => ({ reasoningEffort: "high", model: {
      async *stream(request) {
        expect(request.messages).toBe(owner.getContext().messages)
        expect(Object.isFrozen(request.messages)).toBe(true)
        expect(Object.isFrozen(request.messages[0])).toBe(true)
        requests.push(request)
        yield { type: "finish", reason: "stop" }
      },
    } }),
  })
  let acceptedBeforePublication = false
  agent.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "user") {
      acceptedBeforePublication = owner.getContext().messages.at(-1)?.id === event.message.id
    }
  })
  await agent.prompt("Current prompt").runFinished
  expect(acceptedBeforePublication).toBe(true)
  expect(requests).toHaveLength(1)
  expect(requests[0]?.messages).toHaveLength(1_051)
  expect(requests[0]?.messages.slice(0, history.length)).toEqual(history)
  expect(requests[0]?.messages.at(-1)).toMatchObject({ content: "Current prompt" })
  expect("messages" in agent.state).toBe(false)
  expect(requests[0]?.contextSummary).toBe(owner.getContext().contextSummary)
})

test("Agent observes an external replacement during an active run and removes the old summary", async () => {
  const requests: IAgentModelRequest[] = []
  const { agent, owner } = createAgentFixture({
    sessionId: "session-1", systemPrompt: "System", tools: [],
    resolveRunConfiguration: () => ({ reasoningEffort: "medium", model: {
      async *stream(request) {
        requests.push(request)
        yield { type: "text-delta", id: "answer", delta: "Answer" }
        yield { type: "finish", reason: "stop" }
      },
    } }),
  })
  owner.replaceContext({ messages: [], contextSummary: "Old summary" })
  let oldView: ReturnType<typeof owner.getContext> | undefined
  agent.subscribe((event) => {
    if (event.type !== "message_end" || event.message.role !== "assistant" || requests.length !== 1) return
    oldView = owner.getContext()
    owner.replaceContext({ messages: [] })
    agent.followUp("After replacement")
  })
  await agent.prompt("Before replacement").runFinished
  expect(requests).toHaveLength(2)
  expect(requests[0]?.contextSummary).toBe("Old summary")
  expect(requests[1]?.contextSummary).toBeUndefined()
  expect(requests[1]?.messages).toHaveLength(1)
  expect(requests[1]?.messages[0]).toMatchObject({ source: "followUp", content: "After replacement" })
  expect(oldView?.contextSummary).toBe("Old summary")
  expect(oldView?.messages).toHaveLength(2)
})

for (const failure of [new Error("Required context unavailable"), undefined]) {
  test(`Agent never falls back to its state after a context getter throws ${String(failure)}`, async () => {
    let modelCalls = 0
    const { agent, owner } = createAgentFixture({
      sessionId: "session-1", systemPrompt: "System", tools: [],
      getContext: () => { throw failure },
      resolveRunConfiguration: () => ({ reasoningEffort: "low", model: {
        async *stream() { modelCalls++; yield { type: "finish", reason: "stop" } },
      } }),
    })
    const run = agent.prompt("Committed prompt")
    const results = await Promise.allSettled([run.initialPromptProcessed, run.runFinished])
    expect(results[0]?.status).toBe("fulfilled")
    expect(results[1]).toEqual({ status: "rejected", reason: failure })
    expect(owner.getContext().messages).toHaveLength(1)
    expect(agent.state.lastRunReason).toBe("internal-error")
    expect(modelCalls).toBe(0)
  })
}

test.each(["no tools", "ordinary tool"])("does not read selected paths with %s, even if unused history loading would fail", async (configuration) => {
  let selectedPathReads = 0
  const ordinary = defineAgentTool({
    name: "ordinary", description: "No selected paths needed",
    inputSchema: { type: "object" }, execute: async () => "done",
  })
  const { agent, owner } = createAgentFixture({
    sessionId: "session-1", systemPrompt: "System", tools: configuration === "no tools" ? [] : [ordinary],
    getSelectedPathReferences: () => { selectedPathReads++; throw new Error("Unused selected paths unavailable") },
    resolveRunConfiguration: () => ({ reasoningEffort: "low", model: completedModel() }),
  })
  const run = agent.prompt("Proceed without historical paths")
  await run.initialPromptProcessed
  await run.runFinished
  expect(owner.getContext().messages.map((message) => message.role)).toEqual(["user", "assistant"])
  expect(selectedPathReads).toBe(0)
})

test("selected-path reads follow active tool configuration between runs", async () => {
  let selectedPathReads = 0
  const selectedTool = defineAgentTool({
    name: "selected_read", description: "Read selected paths", acceptsSelectedPathReferences: true,
    inputSchema: { type: "object" }, execute: async () => "done",
  })
  const { agent } = createAgentFixture({
    sessionId: "session-1", systemPrompt: "System", tools: [],
    getSelectedPathReferences: () => { selectedPathReads++; return [] },
    resolveRunConfiguration: () => ({ reasoningEffort: "low", model: completedModel() }),
  })
  await agent.prompt("Without path consumer").runFinished
  expect(selectedPathReads).toBe(0)
  agent.updateConfiguration({ systemPrompt: "System", tools: [selectedTool] })
  await agent.prompt("With path consumer").runFinished
  expect(selectedPathReads).toBe(1)
  agent.replaceContext([])
  await agent.prompt("Without path consumer again").runFinished
  expect(selectedPathReads).toBe(1)
})

test("selected-path loading failure stops the run before prompt acceptance and model dispatch", async () => {
  let modelCalls = 0
  let criticalEvents = 0
  let selectedPathReads = 0
  const selectedTool = defineAgentTool({
    name: "selected_read", description: "Read selected paths", acceptsSelectedPathReferences: true,
    inputSchema: { type: "object" }, execute: async () => "done",
  })
  const { agent, owner } = createAgentFixture({
    sessionId: "session-1", systemPrompt: "System", tools: [selectedTool],
    getSelectedPathReferences: () => { selectedPathReads++; throw new Error("Selected paths unavailable") },
    criticalEventSink: () => { criticalEvents++ },
    resolveRunConfiguration: () => ({ reasoningEffort: "low", model: {
      async *stream() { modelCalls++; yield { type: "finish", reason: "stop" } },
    } }),
  })
  const run = agent.prompt("Do not accept")
  const results = await Promise.allSettled([run.initialPromptProcessed, run.runFinished])
  expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"])
  expect(owner.getContext().messages).toEqual([])
  expect(criticalEvents).toBe(0)
  expect(modelCalls).toBe(0)
  expect(selectedPathReads).toBe(1)
})

/** Explicit test owner; production Agent has no context fallback or history acceptance. */
function createAgentFixture(options: Omit<IAgentOptions, "getContext" | "getSelectedPathReferences" | "getRecentConversation"> &
  Partial<Pick<IAgentOptions, "getContext" | "getSelectedPathReferences" | "getRecentConversation">> &
  { readonly initialMessages?: readonly TAgentMessage[] }) {
  const { initialMessages = [], ...agentOptions } = options
  const owner = new AgentWorkingContext({ messages: initialMessages })
  const agent = new Agent({
    ...agentOptions,
    getContext: options.getContext ?? owner.getContext,
    getRecentConversation: options.getRecentConversation ?? (() => owner.getContext().messages),
    getSelectedPathReferences: options.getSelectedPathReferences ?? (() => []),
    criticalEventSink: async (event, signal) => {
      await options.criticalEventSink?.(event, signal)
      if (event.type === "message_end") owner.acceptCommittedMessage(event.message)
    },
  })
  return { agent, owner }
}

function completedModel(): IAgentModel {
  return {
    async *stream() {
      yield { type: "text-start", id: "answer" }
      yield { type: "text-delta", id: "answer", delta: "Hello" }
      yield { type: "text-end", id: "answer" }
      yield { type: "finish", reason: "stop" }
    },
  }
}

function pathReference(path: string) {
  return {
    type: "path" as const,
    kind: "file" as const,
    path,
    source: { value: "@path", start: 0, end: 5 },
  }
}
