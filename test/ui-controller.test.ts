import { expect, test } from "bun:test"

import type {
  IBuliApplication,
  IBuliApplicationSnapshot,
  IBuliPromptInput,
  IBuliPromptSubmission,
} from "@/application/contracts"
import type { TReasoningEffort } from "@/agent/agent-types"
import type { ISessionInfo, ISessionSnapshot } from "@/domain"
import { BuliUiController } from "@/tui/ui-controller"

const APPLICATION_SNAPSHOT: IBuliApplicationSnapshot = {
  agents: [{ id: "test-agent", name: "Test Agent" }],
  defaultAgentId: "test-agent",
  models: [
    {
      id: "test",
      name: "Test",
      reasoningEfforts: ["low", "medium"],
    },
    {
      id: "other",
      name: "Other",
      reasoningEfforts: ["medium", "high"],
    },
  ],
  selection: {
    modelId: "test",
    reasoningEffort: "medium",
  },
}

interface IApplicationSpyOptions {
  readonly runningSessionId?: string
  readonly selectModel?: (modelId: string) => void
  readonly selectReasoningEffort?: (effort: TReasoningEffort) => void
  readonly accepted?: Promise<void>
  readonly settled?: Promise<void>
  readonly submitPrompt?: (prompt: IBuliPromptInput) => IBuliPromptSubmission
}

function applicationSpy(options: IApplicationSpyOptions = {}) {
  const prompts: IBuliPromptInput[] = []
  const cleared: string[] = []
  const aborted: string[] = []
  const opened: string[] = []
  const created: Array<{ agentId: string; title: string }> = []
  const selectedModels: string[] = []
  const selectedReasoningEfforts: TReasoningEffort[] = []
  let createdCount = 0
  let runCount = 0

  const infos = new Map<string, ISessionInfo>([
    ["session-1", sessionInfo("session-1", "First prompt", 100)],
    ["session-2", sessionInfo("session-2", "Second prompt", 200)],
  ])
  const sources = new Map<string, ReturnType<typeof sessionSource>>(
    [...infos.keys()].map((sessionId) => [
      sessionId,
      sessionSource(sessionId === options.runningSessionId),
    ]),
  )

  const createSession: IBuliApplication["createSession"] = ({ agentId, title }) => {
    created.push({ agentId, title })
    const id = `created-${++createdCount}`
    const info = sessionInfo(id, title.replace(/\s+/g, " ").trim(), 300)
    infos.set(id, info)
    sources.set(id, sessionSource(false))
    return structuredClone(info)
  }

  const application: IBuliApplication = {
    workspaceRoot: "/workspace",
    subscribe: () => () => undefined,
    getSnapshot: () => APPLICATION_SNAPSHOT,
    selectModel: (modelId) => {
      options.selectModel?.(modelId)
      selectedModels.push(modelId)
    },
    selectReasoningEffort: (effort) => {
      options.selectReasoningEffort?.(effort)
      selectedReasoningEfforts.push(effort)
    },
    createSession,
    openSession: (sessionId) => {
      const source = sources.get(sessionId)
      if (!source) throw new Error(`Session does not exist: ${sessionId}`)
      opened.push(sessionId)
      return source
    },
    listSessions: () => structuredClone([...infos.values()]),
    submitPrompt: (prompt) => {
      prompts.push(prompt)
      if (options.submitPrompt) return options.submitPrompt(prompt)

      const sessionId = prompt.sessionId ?? createSession({
        agentId: APPLICATION_SNAPSHOT.defaultAgentId,
        title: prompt.text,
      }).id
      return {
        sessionId,
        runId: `run-${++runCount}`,
        accepted: options.accepted ?? Promise.resolve(),
        settled: options.settled ?? Promise.resolve(),
      }
    },
    clearSession: (sessionId) => {
      cleared.push(sessionId)
    },
    abort: async (sessionId) => {
      aborted.push(sessionId)
    },
    dispose: async () => undefined,
  }

  return {
    application,
    prompts,
    cleared,
    aborted,
    opened,
    created,
    selectedModels,
    selectedReasoningEfforts,
  }
}

test("publishes all command suggestions from slash input", () => {
  const spy = applicationSpy()
  const controller = new BuliUiController({ application: spy.application })
  const initial = controller.getSnapshot()
  let notifications = 0
  controller.subscribe(() => {
    notifications += 1
  })

  controller.updateInput("/")

  expect(controller.getSnapshot()).not.toBe(initial)
  expect(controller.getSnapshot().menu?.items.map((item) => item.id)).toEqual([
    "clear",
    "model",
    "reasoning",
    "new",
    "sessions",
  ])
  expect(notifications).toBe(1)
})

test("creates the first session only when a prompt is submitted from Home", async () => {
  const spy = applicationSpy()
  const controller = new BuliUiController({ application: spy.application })

  expect(controller.getSnapshot()).toEqual({
    route: { type: "home" },
    menu: null,
    input: "",
    inputError: null,
  })
  expect(spy.created).toEqual([])

  await controller.submitInput("  First\n prompt  ")

  expect(spy.created).toEqual([{
    agentId: "test-agent",
    title: "First\n prompt",
  }])
  expect(controller.getSnapshot().route).toEqual({
    type: "session",
    sessionId: "created-1",
  })
  expect(spy.prompts).toEqual([{
    text: "First\n prompt",
  }])
})

test("opens a new session only after its prompt is accepted", async () => {
  const accepted = Promise.withResolvers<void>()
  const spy = applicationSpy({
    accepted: accepted.promise,
    settled: accepted.promise,
  })
  const controller = new BuliUiController({ application: spy.application })

  const submission = controller.submitInput("First prompt")
  await Promise.resolve()

  expect(controller.getSnapshot().route).toEqual({ type: "home" })

  accepted.resolve()
  expect(await submission).toBe("consumed")
  expect(controller.getSnapshot().route).toEqual({
    type: "session",
    sessionId: "created-1",
  })
})

test("retains a second submission while prompt acceptance is pending", async () => {
  const accepted = Promise.withResolvers<void>()
  const spy = applicationSpy({
    accepted: accepted.promise,
    settled: accepted.promise,
  })
  const controller = new BuliUiController({ application: spy.application })

  const firstSubmission = controller.submitInput("First prompt")
  await Promise.resolve()
  const secondResult = await controller.submitInput("Second prompt")

  expect(secondResult).toBe("retained")
  expect(spy.prompts).toEqual([{ text: "First prompt" }])
  expect(controller.getSnapshot().inputError).toBe(
    "Prompt submission is still pending",
  )

  accepted.resolve()
  expect(await firstSubmission).toBe("consumed")
})

test("allows only one concurrent unknown slash command submission", async () => {
  const accepted = Promise.withResolvers<void>()
  const spy = applicationSpy({
    accepted: accepted.promise,
    settled: accepted.promise,
  })
  const controller = new BuliUiController({ application: spy.application })
  controller.updateInput("/unknown")

  const firstSubmission = controller.submitInput("/unknown")
  const secondResult = await controller.submitInput("/unknown")
  await Promise.resolve()

  expect(secondResult).toBe("retained")
  expect(spy.prompts).toEqual([{ text: "/unknown" }])
  expect(controller.getSnapshot()).toMatchObject({
    input: "/unknown",
    inputError: "Prompt submission is still pending",
  })

  accepted.resolve()
  expect(await firstSubmission).toBe("consumed")
})

test("retains synchronous subscriber reentry during submission", async () => {
  const accepted = Promise.withResolvers<void>()
  const spy = applicationSpy({
    accepted: accepted.promise,
    settled: accepted.promise,
  })
  const controller = new BuliUiController({ application: spy.application })
  controller.updateInput("First prompt")
  let didReenter = false
  let reentryTask: ReturnType<BuliUiController["submitInput"]> | undefined
  controller.subscribe(() => {
    if (didReenter) return
    didReenter = true
    reentryTask = controller.submitInput("Reentered prompt")
  })

  const firstSubmission = controller.submitInput("First prompt")
  await Promise.resolve()

  if (!reentryTask) throw new Error("Expected synchronous subscriber reentry")
  expect(await reentryTask).toBe("retained")
  expect(spy.prompts).toEqual([{ text: "First prompt" }])
  expect(controller.getSnapshot()).toMatchObject({
    input: "First prompt",
    inputError: "Prompt submission is still pending",
  })

  accepted.resolve()
  expect(await firstSubmission).toBe("consumed")
})

test("does not replace a route changed while Home acceptance is pending", async () => {
  const accepted = Promise.withResolvers<void>()
  const spy = applicationSpy({
    accepted: accepted.promise,
    settled: accepted.promise,
  })
  const controller = new BuliUiController({ application: spy.application })

  const submission = controller.submitInput("First prompt")
  await Promise.resolve()
  controller.activateSession("session-2")

  accepted.resolve()
  expect(await submission).toBe("consumed")
  expect(controller.getSnapshot().route).toEqual({
    type: "session",
    sessionId: "session-2",
  })
})

test("opens model picker at the current model and activates a selection", async () => {
  const spy = applicationSpy()
  const controller = new BuliUiController({ application: spy.application })

  await controller.submitInput("/model")
  expect(controller.getSnapshot().menu).toMatchObject({
    mode: "picker",
    commandName: "model",
    selectedIndex: 0,
  })

  controller.moveMenuSelection(1)
  await controller.activateSelectedMenuItem()

  expect(spy.selectedModels).toEqual(["other"])
  expect(controller.getSnapshot().menu).toBeNull()
  expect(spy.prompts).toEqual([])
  expect(spy.created).toEqual([])
})

test("opens reasoning picker with efforts supported by the current model", async () => {
  const spy = applicationSpy()
  const controller = new BuliUiController({ application: spy.application })

  await controller.submitInput("/reasoning")
  expect(controller.getSnapshot().menu).toMatchObject({
    mode: "picker",
    commandName: "reasoning",
    items: [
      { id: "low", label: "low" },
      { id: "medium", label: "medium" },
    ],
    selectedIndex: 1,
  })

  controller.moveMenuSelection(-1)
  await controller.activateSelectedMenuItem()

  expect(spy.selectedReasoningEfforts).toEqual(["low"])
  expect(controller.getSnapshot().menu).toBeNull()
})

test("keeps a picker open when selection fails", async () => {
  const spy = applicationSpy({
    selectModel: () => {
      throw new Error("Unsupported reasoning effort: medium")
    },
  })
  const controller = new BuliUiController({ application: spy.application })

  await controller.submitInput("/model")
  controller.moveMenuSelection(1)
  await controller.activateSelectedMenuItem()

  expect(controller.getSnapshot().menu).toMatchObject({
    mode: "picker",
    commandName: "model",
    selectedIndex: 1,
    errorMessage: "Unsupported reasoning effort: medium",
  })
  expect(spy.selectedModels).toEqual([])
})

test("opens saved sessions and marks the active session", async () => {
  const spy = applicationSpy()
  const controller = new BuliUiController({ application: spy.application })
  controller.activateSession("session-1")

  await controller.submitInput("/sessions")

  expect(controller.getSnapshot().menu).toMatchObject({
    mode: "picker",
    commandName: "sessions",
    selectedIndex: 0,
    items: [
      { id: "session-1", label: "First prompt" },
      { id: "session-2", label: "Second prompt" },
    ],
  })

  controller.moveMenuSelection(1)
  await controller.activateSelectedMenuItem()

  expect(controller.getSnapshot().route).toEqual({
    type: "session",
    sessionId: "session-2",
  })
  expect(spy.opened).toContain("session-2")
})

test("new returns Home without creating an empty session", async () => {
  const spy = applicationSpy()
  const controller = new BuliUiController({ application: spy.application })
  controller.activateSession("session-1")

  await controller.submitInput("/new")

  expect(controller.getSnapshot().route).toEqual({ type: "home" })
  expect(spy.created).toEqual([])
})

test("blocks session changes while the current session is running", async () => {
  const spy = applicationSpy({ runningSessionId: "session-1" })
  const controller = new BuliUiController({ application: spy.application })
  controller.activateSession("session-1")
  await controller.submitInput("/sessions")
  controller.moveMenuSelection(1)

  await controller.activateSelectedMenuItem()

  expect(controller.getSnapshot().route).toEqual({
    type: "session",
    sessionId: "session-1",
  })
  expect(controller.getSnapshot().menu).toMatchObject({
    mode: "picker",
    errorMessage: "Cannot switch sessions while the current session is running",
  })
})

test("shows an error when direct new is blocked by an active run", async () => {
  const spy = applicationSpy({ runningSessionId: "session-1" })
  const controller = new BuliUiController({ application: spy.application })
  controller.activateSession("session-1")

  await controller.submitInput("/new")

  expect(controller.getSnapshot().route).toEqual({
    type: "session",
    sessionId: "session-1",
  })
  expect(controller.getSnapshot().menu).toMatchObject({
    mode: "commands",
    errorMessage: "Cannot switch sessions while the current session is running",
  })
})

test("handles clear and abort against only the active session", async () => {
  const spy = applicationSpy()
  const controller = new BuliUiController({ application: spy.application })

  await controller.submitInput("/clear")
  controller.escape()
  expect(spy.cleared).toEqual([])
  expect(spy.aborted).toEqual([])

  controller.activateSession("session-2")
  await controller.submitInput("/clear")
  controller.escape()

  expect(spy.cleared).toEqual(["session-2"])
  expect(spy.aborted).toEqual(["session-2"])
})

test("empty input preserves a picker while typed input closes it", async () => {
  const spy = applicationSpy()
  const controller = new BuliUiController({ application: spy.application })

  await controller.submitInput("/model")
  const picker = controller.getSnapshot().menu

  controller.updateInput("")
  expect(controller.getSnapshot().menu).toBe(picker)

  controller.updateInput("x")
  expect(controller.getSnapshot().menu).toBeNull()
})

function sessionInfo(id: string, title: string, updatedAt: number): ISessionInfo {
  return {
    id,
    agentId: "test-agent",
    title,
    createdAt: updatedAt,
    updatedAt,
  }
}

function sessionSource(isRunning: boolean) {
  const snapshot: ISessionSnapshot = {
    messages: [],
    isRunning,
    pendingToolCallIds: [],
  }
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
  }
}
