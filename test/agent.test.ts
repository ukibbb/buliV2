import { expect, test } from "bun:test"

import { Agent } from "@/agent/agent"
import type { IAgentModel } from "@/agent/agent-types"

test("Agent owns live state and awaits event listeners", async () => {
  const listenerReleased = Promise.withResolvers<void>()
  const model: IAgentModel = {
    async *stream() {
      yield { type: "text-start", id: "answer" }
      yield { type: "text-delta", id: "answer", delta: "Hello" }
      yield { type: "text-end", id: "answer" }
      yield { type: "finish", reason: "stop" }
    },
  }
  const agent = new Agent({
    sessionId: "session-1",
    systemPrompt: "System",
    model,
    tools: [],
  })
  let stateObservedDuringMessageEnd = false
  agent.subscribe(async (event) => {
    if (event.type !== "message_end" || event.message.role !== "assistant") {
      return
    }
    stateObservedDuringMessageEnd = agent.state.messages.at(-1)?.id
      === event.message.id
    await listenerReleased.promise
  })

  const prompt = agent.prompt("Question")
  await waitUntil(() => stateObservedDuringMessageEnd)

  expect(agent.state.isRunning).toBe(true)
  expect(agent.state.streamingMessage).toBeUndefined()

  listenerReleased.resolve()
  await prompt

  expect(agent.state.isRunning).toBe(false)
  expect(agent.state.messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
  ])
})

test("Agent rejects overlap, aborts the active run, and can clear when idle", async () => {
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
    model,
    tools: [],
  })
  const first = agent.prompt("First")
  await started.promise

  await expect(agent.prompt("Second")).rejects.toThrow(
    "Agent is already processing a prompt",
  )
  expect(() => agent.clear()).toThrow("Cannot clear while Agent is running")

  agent.abort()
  await first
  agent.clear()

  expect(agent.state.messages).toEqual([])
  expect(() => agent.abort()).not.toThrow()
})

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return
    await Bun.sleep(1)
  }
  throw new Error("Condition was not met")
}
