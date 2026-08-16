import { expect, test } from "bun:test"

import { Agent } from "@/agent/agent"
import type {
  IAgentEvent,
  IAgentModel,
  IAgentModelRequest,
} from "@/agent/agent-types"

test("Agent.prompt returns a synchronous handle and Agent owns live state", async () => {
  const agent = new Agent({
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
    stateObservedDuringMessageEnd = agent.state.messages.at(-1)?.id
      === event.message.id
  })

  const run = agent.prompt("Question")

  expect(agent.state.isRunning).toBe(true)
  expect(agent.state.activeRunId).toBe(run.runId)
  expect(run.accepted).toBeInstanceOf(Promise)
  expect(run.settled).toBeInstanceOf(Promise)

  await run.accepted
  await run.settled

  expect(stateObservedDuringMessageEnd).toBe(true)
  expect(agent.state.isRunning).toBe(false)
  expect(agent.state.messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
  ])
  expect(agent.state.messages[0]).toMatchObject({
    runId: run.runId,
    role: "user",
    source: "prompt",
    content: "Question",
  })
  expect(agent.state.messages[1]).toMatchObject({
    runId: run.runId,
    role: "assistant",
  })
})

test("accepted resolves after the critical sink handles the user message_end", async () => {
  const sinkEntered = Promise.withResolvers<void>()
  const releaseSink = Promise.withResolvers<void>()
  let sinkHandled = false
  const agent = new Agent({
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
  let acceptedResolved = false
  void run.accepted.then(() => {
    acceptedResolved = true
  })
  await sinkEntered.promise

  expect(acceptedResolved).toBe(false)
  expect(agent.state.messages).toEqual([])

  releaseSink.resolve()
  await run.accepted

  expect(sinkHandled).toBe(true)
  expect(agent.state.messages[0]).toMatchObject({
    runId: run.runId,
    role: "user",
    source: "prompt",
    content: "Question",
  })

  await run.settled
})

test("critical sink failure rejects accepted and settled without adding the user message", async () => {
  const sinkFailure = new Error("Failed to persist prompt")
  const agent = new Agent({
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
  const acceptedFailure = run.accepted.then(
    () => undefined,
    (error: unknown) => error,
  )
  const settledFailure = run.settled.then(
    () => undefined,
    (error: unknown) => error,
  )

  expect(await acceptedFailure).toBe(sinkFailure)
  expect(await settledFailure).toBe(sinkFailure)

  expect(agent.state.messages).toEqual([])
  expect(agent.state.isRunning).toBe(false)
})

test("critical sink throwing undefined rejects accepted and settled", async () => {
  const agent = new Agent({
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
  const [accepted, settled, idleResult, abortResult] = await Promise.allSettled([
    run.accepted,
    run.settled,
    idle,
    aborted,
  ])

  expect(accepted.status).toBe("rejected")
  expect(settled.status).toBe("rejected")
  expect(idleResult.status).toBe("rejected")
  expect(abortResult.status).toBe("rejected")
  expect(agent.state.isRunning).toBe(false)
  expect(agent.state.lastRunReason).toBe("internal-error")
  expect(agent.state.messages).toEqual([])
})

test("public observer exceptions do not fail the run", async () => {
  const observerFailure = new Error("Observer failed")
  const observerErrors: unknown[] = []
  const agent = new Agent({
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
  await run.accepted
  await run.settled

  expect(observerErrors).toEqual([observerFailure])
  expect(agent.state.messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
  ])
  expect(agent.state.lastRunReason).toBe("completed")
})

test("agent_settled appears exactly once and all events carry the runId", async () => {
  const events: IAgentEvent[] = []
  const agent = new Agent({
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
  await run.settled

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
  const agent = new Agent({
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
  await first.settled
  await idle
  await continuation?.settled

  expect(agent.state.messages.filter((message) => message.role === "user"))
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
  const agent = new Agent({
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
  await run.accepted
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
  await run.settled

  expect(requests).toHaveLength(3)
  expect(requests[2]?.messages.at(-1)).toMatchObject({
    runId: run.runId,
    role: "user",
    source: "steer",
    content: "Second steering",
  })
  expect(agent.pendingSteeringMessages).toEqual([])
  expect(agent.state.messages.filter((message) => message.role === "user").map(
    (message) => message.source,
  )).toEqual(["prompt", "steer", "steer"])
})

test("Agent delivers follow-ups FIFO only after it would otherwise stop", async () => {
  const firstStarted = Promise.withResolvers<void>()
  const releaseFirst = Promise.withResolvers<void>()
  const requests: IAgentModelRequest[] = []
  const agent = new Agent({
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
  await run.accepted
  await firstStarted.promise
  agent.followUp("First follow-up")
  agent.followUp("Second follow-up")

  expect(agent.pendingFollowUpMessages.map((message) => message.content)).toEqual([
    "First follow-up",
    "Second follow-up",
  ])

  releaseFirst.resolve()
  await run.settled

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
  expect(agent.state.messages.filter((message) => message.role === "user").map(
    (message) => message.source,
  )).toEqual(["prompt", "followUp", "followUp"])
})

test("Agent rejects steering until the initial prompt is durable", async () => {
  const promptPersistenceStarted = Promise.withResolvers<void>()
  const releasePromptPersistence = Promise.withResolvers<void>()
  const firstRequestStarted = Promise.withResolvers<void>()
  const releaseFirstRequest = Promise.withResolvers<void>()
  const requests: IAgentModelRequest[] = []
  const agent = new Agent({
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
  await run.accepted
  await firstRequestStarted.promise
  agent.steer("Include this next")
  releaseFirstRequest.resolve()
  await run.settled

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

test("Agent keeps steering recoverable when the iteration limit prevents delivery", async () => {
  const modelStarted = Promise.withResolvers<void>()
  const releaseModel = Promise.withResolvers<void>()
  const agent = new Agent({
    sessionId: "session-1",
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
    maxProviderIterations: 1,
  })

  const run = agent.prompt("Initial prompt")
  await run.accepted
  await modelStarted.promise
  agent.steer("Try another approach")
  agent.followUp("Then summarize it")
  releaseModel.resolve()
  await run.settled

  expect(agent.state.lastRunReason).toBe("max-iterations")
  expect(agent.pendingSteeringMessages).toEqual([
    expect.objectContaining({
      runId: run.runId,
      source: "steer",
      content: "Try another approach",
    }),
  ])
  expect(agent.pendingFollowUpMessages).toEqual([
    expect.objectContaining({
      runId: run.runId,
      source: "followUp",
      content: "Then summarize it",
    }),
  ])
  expect(() => agent.prompt("Another prompt")).toThrow(
    "Restore queued messages before starting another prompt",
  )
  const queued = agent.clearQueuedMessages()
  expect(queued.steering.map((message) => message.content)).toEqual([
    "Try another approach",
  ])
  expect(queued.followUp.map((message) => message.content)).toEqual([
    "Then summarize it",
  ])
})

test("Agent rejects overlap, abort settles the active run, and can clear when idle", async () => {
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
  const agent = new Agent({
    sessionId: "session-1",
    systemPrompt: "System",
    resolveRunConfiguration: () => ({
      model,
      reasoningEffort: "medium",
    }),
    tools: [],
  })
  const first = agent.prompt("First")
  await first.accepted
  await started.promise

  expect(() => agent.prompt("Second")).toThrow(
    "Agent is already processing a prompt",
  )
  expect(() => agent.clear()).toThrow("Cannot clear while Agent is running")

  await Promise.all([agent.abort(), first.settled])

  expect(agent.state.isRunning).toBe(false)
  expect(agent.state.lastRunReason).toBe("aborted")

  agent.clear()

  expect(agent.state.messages).toEqual([])
  await expect(agent.abort()).resolves.toBeUndefined()
})

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
