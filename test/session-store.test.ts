import { expect, test } from "bun:test"
import type { IBuliMessageWithParts } from "@/domain"
import { InMemorySessionStore } from "@/engine/session-store"
import { SessionView } from "@/runtime/session-view"

test("stores independent message copies and replaces messages by ID", () => {
  const store = new InMemorySessionStore()
  const original = userMessage("First")

  store.publish(original)

  const originalPart = original.parts[0]
  if (originalPart?.type === "text") {
    ;(originalPart as { text: string }).text = "Mutated outside store"
  }

  expect(store.getHistory("session-1")[0]?.parts[0]).toMatchObject({
    text: "First",
  })

  store.publish(userMessage("Replacement"))

  const history = store.getHistory("session-1")
  expect(history).toHaveLength(1)
  expect(history[0]?.parts[0]).toMatchObject({
    text: "Replacement",
  })
})

test("exposes stable frozen snapshots until a session changes", () => {
  const store = new InMemorySessionStore()
  const empty = store.getSnapshot("session-1")

  expect(store.getSnapshot("session-1")).toBe(empty)

  store.publish(userMessage("First"))

  const snapshot = store.getSnapshot("session-1")
  expect(snapshot).not.toBe(empty)
  expect(store.getSnapshot("session-1")).toBe(snapshot)
  expect(Object.isFrozen(snapshot)).toBe(true)
  expect(Object.isFrozen(snapshot.messages)).toBe(true)
  expect(Object.isFrozen(snapshot.messages[0])).toBe(true)
  expect(Object.isFrozen(snapshot.messages[0]?.parts)).toBe(true)
})

test("freezes structured tool input and output", () => {
  const store = new InMemorySessionStore()
  store.publish({
    info: {
      id: "assistant-1",
      sessionId: "session-1",
      role: "assistant",
      createdAt: 1,
    },
    parts: [{
      id: "tool-1",
      messageId: "assistant-1",
      sessionId: "session-1",
      createdAt: 1,
      type: "tool",
      callID: "call-1",
      tool: "grep",
      status: "completed",
      input: { pattern: "SessionEngine" },
      output: { matches: ["src/engine/session-engine.ts"] },
      execution: "local",
    }],
  })

  const part = store.getSnapshot("session-1").messages[0]?.parts[0]
  if (part?.type !== "tool") throw new Error("Expected a tool part")

  expect(Object.isFrozen(part.input)).toBe(true)
  expect(Object.isFrozen(part.output)).toBe(true)
  expect(
    part.output !== null
    && typeof part.output === "object"
    && !Array.isArray(part.output)
    && Object.isFrozen(part.output.matches),
  ).toBe(true)
})

test("projects store updates through a stable session snapshot", () => {
  const store = new InMemorySessionStore()
  const view = new SessionView("session-1", store)
  const initial = view.getSnapshot()
  let notifications = 0

  view.subscribe(() => {
    notifications += 1
  })

  store.publish(userMessage("First"))

  const current = view.getSnapshot()
  expect(current).not.toBe(initial)
  expect(view.getSnapshot()).toBe(current)
  expect(current.messages[0]?.parts[0]).toMatchObject({
    text: "First",
  })
  expect(notifications).toBe(1)

  view.dispose()
  store.publish(userMessage("After disposal"))

  expect(view.getSnapshot()).toBe(current)
})

test("resets snapshots without removing subscribers", () => {
  const store = new InMemorySessionStore()
  let notifications = 0
  const unsubscribe = store.subscribe("session-1", () => {
    notifications += 1
  })

  store.publish(userMessage("Before reset"))
  store.reset()

  expect(store.getHistory("session-1")).toEqual([])
  expect(notifications).toBe(2)

  store.publish(userMessage("After reset"))

  expect(store.getHistory("session-1")[0]?.parts[0]).toMatchObject({
    text: "After reset",
  })
  expect(notifications).toBe(3)

  unsubscribe()
})

test("rejects parts linked to another message or session", () => {
  const store = new InMemorySessionStore()

  expect(() => {
    store.publish({
      ...userMessage("Invalid"),
      parts: [
        {
          id: "part-1",
          messageId: "other-message",
          sessionId: "session-1",
          createdAt: 1,
          type: "text",
          text: "Invalid",
        },
      ],
    })
  }).toThrow("belongs to another message")

  expect(() => {
    store.publish({
      ...userMessage("Invalid"),
      parts: [
        {
          id: "part-1",
          messageId: "message-1",
          sessionId: "other-session",
          createdAt: 1,
          type: "text",
          text: "Invalid",
        },
      ],
    })
  }).toThrow("belongs to another session")
})

function userMessage(text: string): IBuliMessageWithParts {
  return {
    info: {
      id: "message-1",
      sessionId: "session-1",
      role: "user",
      createdAt: 1,
    },
    parts: [
      {
        id: "part-1",
        messageId: "message-1",
        sessionId: "session-1",
        createdAt: 1,
        type: "text",
        text,
      },
    ],
  }
}
