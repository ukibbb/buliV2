import { expect, test } from "bun:test"

import type { IAgentModel } from "@/agent/agent-types"
import type { IUserMessage } from "@/domain"
import { AgentSession } from "@/session/agent-session"
import { InMemorySessionManager } from "@/session/session-manager"

test("AgentSession restores history, persists completion barriers, and publishes stable snapshots", async () => {
  const manager = new InMemorySessionManager()
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
    sessionId: "session-1",
    manager,
    systemPrompt: "System",
    resolveRunConfiguration: () => ({
      model,
      reasoningEffort: "medium",
    }),
    tools: [],
  })
  const initial = session.getSnapshot()
  let notifications = 0
  session.subscribe(() => {
    notifications += 1
  })

  await session.prompt("Question")

  expect(persistedBeforeModel).toEqual([2])
  expect(manager.getMessages("session-1")).toHaveLength(3)
  expect(session.getSnapshot()).not.toBe(initial)
  expect(session.getSnapshot()).toBe(session.getSnapshot())
  expect(session.getSnapshot().messages.map((message) => message.role)).toEqual([
    "user",
    "user",
    "assistant",
  ])
  expect(session.getSnapshot().isRunning).toBe(false)
  expect(notifications).toBeGreaterThan(0)
})

test("AgentSession clear removes one durable session without detaching subscribers", async () => {
  const manager = new InMemorySessionManager()
  manager.appendMessage(userMessage("First", "session-1", "user-1"))
  manager.appendMessage(userMessage("Other", "session-2", "user-2"))
  const session = new AgentSession({
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
})

function userMessage(
  content: string,
  sessionId = "session-1",
  id = "restored-user",
): IUserMessage {
  return {
    id,
    sessionId,
    role: "user",
    content,
    createdAt: 1,
  }
}
