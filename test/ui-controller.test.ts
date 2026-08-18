import { expect, test } from "bun:test"

import type {
  IBuliApplication,
  IBuliApplicationSnapshot,
  IBuliPromptInput,
  IBuliPromptSubmission,
  IBuliQueuedMessages,
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
  readonly steer?: (sessionId: string, text: string) => void
  readonly followUp?: (sessionId: string, text: string) => void
  readonly clearQueuedMessages?: (sessionId: string) => IBuliQueuedMessages
}

function applicationSpy(options: IApplicationSpyOptions = {}) {
  const prompts: IBuliPromptInput[] = []
  const cleared: string[] = []
  const aborted: string[] = []
  const opened: string[] = []
  const created: Array<{ agentId: string; title: string }> = []
  const selectedModels: string[] = []
  const selectedReasoningEfforts: TReasoningEffort[] = []
  const steering: Array<{ sessionId: string; text: string }> = []
  const followUps: Array<{ sessionId: string; text: string }> = []
  const clearedQueues: string[] = []
  const compacted: string[] = []
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
    steer: (sessionId, text) => {
      options.steer?.(sessionId, text)
      steering.push({ sessionId, text })
    },
    followUp: (sessionId, text) => {
      options.followUp?.(sessionId, text)
      followUps.push({ sessionId, text })
    },
    clearQueuedMessages: (sessionId) => {
      clearedQueues.push(sessionId)
      return options.clearQueuedMessages?.(sessionId) ?? {
        steering: [],
        followUp: [],
      }
    },
    clearSession: (sessionId) => {
      cleared.push(sessionId)
    },
    compactSession: async (sessionId) => {
      compacted.push(sessionId)
      return undefined
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
    steering,
    followUps,
    clearedQueues,
    compacted,
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
    "login",
    "logout",
    "compact",
  ])
  expect(notifications).toBe(1)
})

test("creates the first session only when a prompt is submitted from Home", async () => {
  const spy = applicationSpy()
  const controller = new BuliUiController({ application: spy.application })

  expect(controller.getSnapshot()).toEqual({
    route: { type: "home" },
    authenticationMode: null,
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

test("routes Enter to steering while the active session is running", async () => {
  const spy = applicationSpy({ runningSessionId: "session-1" })
  const controller = new BuliUiController({ application: spy.application })
  controller.activateSession("session-1")
  controller.updateInput("Adjust the answer")

  const result = await controller.submitInput("Adjust the answer")

  expect(result).toBe("consumed")
  expect(spy.steering).toEqual([{
    sessionId: "session-1",
    text: "Adjust the answer",
  }])
  expect(spy.prompts).toEqual([])
  expect(controller.getSnapshot().input).toBe("")
})

test("routes Alt+Enter delivery to follow-up while a session is running", async () => {
  const spy = applicationSpy({ runningSessionId: "session-1" })
  const controller = new BuliUiController({ application: spy.application })
  controller.activateSession("session-1")
  controller.updateInput("Summarize when finished")

  const result = await controller.submitInput(
    "Summarize when finished",
    "followUp",
  )

  expect(result).toBe("consumed")
  expect(spy.followUps).toEqual([{
    sessionId: "session-1",
    text: "Summarize when finished",
  }])
  expect(spy.steering).toEqual([])
  expect(spy.prompts).toEqual([])
  expect(controller.getSnapshot().input).toBe("")
})

test("retains follow-up input when there is no active run", async () => {
  const spy = applicationSpy()
  const controller = new BuliUiController({ application: spy.application })
  controller.updateInput("Run this later")

  const result = await controller.submitInput("Run this later", "followUp")

  expect(result).toBe("retained")
  expect(spy.followUps).toEqual([])
  expect(spy.prompts).toEqual([])
  expect(controller.getSnapshot()).toMatchObject({
    input: "Run this later",
    inputError: "Follow-up requires an active run",
  })
})

test("retains input when a finishing run rejects steering", async () => {
  const spy = applicationSpy({
    runningSessionId: "session-1",
    steer: () => {
      throw new Error("Agent is not accepting steering messages")
    },
  })
  const controller = new BuliUiController({ application: spy.application })
  controller.activateSession("session-1")
  controller.updateInput("Late steering")

  const result = await controller.submitInput("Late steering")

  expect(result).toBe("retained")
  expect(spy.steering).toEqual([])
  expect(controller.getSnapshot()).toMatchObject({
    input: "Late steering",
    inputError: "Agent is not accepting steering messages",
  })
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

test("login and logout commands activate authentication mode", async () => {
  const spy = applicationSpy()
  const controller = new BuliUiController({ application: spy.application })

  expect(await controller.submitInput("/login")).toBe("consumed")
  expect(controller.getSnapshot().authenticationMode).toBe("login")
  expect(spy.prompts).toEqual([])

  controller.escape()
  expect(controller.getSnapshot().authenticationMode).toBeNull()

  expect(await controller.submitInput("/logout")).toBe("consumed")
  expect(controller.getSnapshot().authenticationMode).toBe("logout")
  expect(spy.prompts).toEqual([])
})

test("known slash commands reject arguments instead of sending a prompt", async () => {
  const spy = applicationSpy()
  const controller = new BuliUiController({ application: spy.application })

  expect(await controller.submitInput("/login openai")).toBe("retained")
  expect(controller.getSnapshot()).toMatchObject({
    authenticationMode: null,
    inputError: "/login does not accept arguments",
  })
  expect(spy.prompts).toEqual([])
  expect(spy.created).toEqual([])
})

test("Escape closes authentication without changing the session or draft", () => {
  const spy = applicationSpy({ runningSessionId: "session-1" })
  const controller = new BuliUiController({ application: spy.application })
  controller.activateSession("session-1")
  controller.updateInput("Preserved draft")
  controller.openAuthentication("login")

  controller.escape()

  expect(controller.getSnapshot()).toMatchObject({
    route: { type: "session", sessionId: "session-1" },
    authenticationMode: null,
    input: "Preserved draft",
  })
  expect(spy.aborted).toEqual([])
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

test("compact command targets the active session", async () => {
  const spy = applicationSpy()
  const controller = new BuliUiController({ application: spy.application })
  controller.activateSession("session-1")

  expect(await controller.submitInput("/compact")).toBe("consumed")
  expect(spy.compacted).toEqual(["session-1"])
})

test("Escape restores queued steering before the current draft and aborts", () => {
  const spy = applicationSpy({
    clearQueuedMessages: () => ({
      steering: ["First steering", "Second steering"],
      followUp: ["Later follow-up"],
    }),
  })
  const controller = new BuliUiController({ application: spy.application })
  controller.activateSession("session-1")
  controller.updateInput("Current draft")

  controller.escape()

  expect(spy.clearedQueues).toEqual(["session-1"])
  expect(spy.aborted).toEqual(["session-1"])
  expect(controller.getSnapshot()).toMatchObject({
    input: "First steering\n\nSecond steering\n\nLater follow-up\n\nCurrent draft",
    inputError: null,
  })
})

test("Escape closes an open menu and still restores an active steering queue", () => {
  const spy = applicationSpy({
    runningSessionId: "session-1",
    clearQueuedMessages: () => ({
      steering: ["Queued while menu was open"],
      followUp: [],
    }),
  })
  const controller = new BuliUiController({ application: spy.application })
  controller.activateSession("session-1")
  controller.updateInput("/")

  expect(controller.getSnapshot().menu).not.toBeNull()
  controller.escape()

  expect(controller.getSnapshot()).toMatchObject({
    menu: null,
    input: "Queued while menu was open\n\n/",
  })
  expect(spy.aborted).toEqual(["session-1"])
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
    pendingSteeringMessages: [],
    pendingFollowUpMessages: [],
    isRunning,
    pendingToolCallIds: [],
  }
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
  }
}
