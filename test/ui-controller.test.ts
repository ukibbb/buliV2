import { expect, test } from "bun:test"

import type {
  IBuliApplication,
  IBuliApplicationSnapshot,
  IBuliPromptInput,
} from "@/application"
import type { ISessionSnapshot } from "@/domain"
import { BuliUiController } from "@/tui/ui-controller"

const SESSION_SNAPSHOT: ISessionSnapshot = {
  messages: [],
  isRunning: false,
  pendingToolCallIds: [],
}

const APPLICATION_SNAPSHOT: IBuliApplicationSnapshot = {
  models: [{
    id: "test",
    name: "Test",
    reasoningEfforts: ["medium"],
  }],
  selection: {
    modelId: "test",
    reasoningEffort: "medium",
  },
}

function applicationSpy() {
  const prompts: IBuliPromptInput[] = []
  const cleared: string[] = []
  const aborted: string[] = []
  const session = {
    subscribe: () => () => undefined,
    getSnapshot: () => SESSION_SNAPSHOT,
  }

  const application: IBuliApplication = {
    workspaceRoot: "/workspace",
    subscribe: () => () => undefined,
    getSnapshot: () => APPLICATION_SNAPSHOT,
    selectModel: () => undefined,
    selectReasoningEffort: () => undefined,
    createAgentSession: () => session,
    submitPrompt: async (prompt) => {
      prompts.push(prompt)
    },
    clearSession: (sessionId) => {
      cleared.push(sessionId)
    },
    abort: (sessionId) => {
      aborted.push(sessionId)
    },
    getAgentSession: () => session,
  }

  return { application, prompts, cleared, aborted }
}

test("publishes command suggestions from slash input", () => {
  const spy = applicationSpy()
  const controller = new BuliUiController({
    application: spy.application,
    sessionId: "session-1",
  })
  const initial = controller.getSnapshot()
  let notifications = 0
  controller.subscribe(() => {
    notifications += 1
  })

  controller.updateInput("/")

  expect(controller.getSnapshot()).not.toBe(initial)
  expect(controller.getSnapshot().commandMenu).toEqual({
    items: [{ name: "clear", description: "Clear the current session" }],
    selectedIndex: 0,
  })
  expect(notifications).toBe(1)
})

test("handles exact clear commands and forwards other slash input", async () => {
  const spy = applicationSpy()
  const controller = new BuliUiController({
    application: spy.application,
    sessionId: "session-1",
  })

  await controller.submitInput("  /clear  ")
  await controller.submitInput("/clear now")
  await controller.submitInput("/reset")

  expect(spy.cleared).toEqual(["session-1"])
  expect(spy.prompts).toEqual([
    { sessionId: "session-1", text: "/clear now" },
    { sessionId: "session-1", text: "/reset" },
  ])
})

test("Escape closes command suggestions before aborting", () => {
  const spy = applicationSpy()
  const controller = new BuliUiController({
    application: spy.application,
    sessionId: "session-1",
  })

  controller.updateInput("/")
  controller.escape()

  expect(controller.getSnapshot().commandMenu).toBeNull()
  expect(spy.aborted).toEqual([])

  controller.escape()
  expect(spy.aborted).toEqual(["session-1"])
})
