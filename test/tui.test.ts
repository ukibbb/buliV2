import { expect, test } from "bun:test"
import {
  CodeRenderable,
  parseKeypress,
  type Renderable,
  TextareaRenderable,
} from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { act, createElement } from "react"

import { createBuliApplication } from "@/application"
import type {
  IBuliApplication,
  IBuliApplicationSnapshot,
  IBuliPromptInput,
  IBuliPromptSubmission,
} from "@/application/contracts"
import { BuliApplicationRuntime } from "@/application/runtime"
import { BuliRuntimeProvider } from "@/application-state"
import type { IAgentModel } from "@/agent/agent-types"
import type { ISessionSnapshot } from "@/domain"
import { InMemorySessionManager } from "@/session/session-manager"
import { BuliTui } from "@/tui/Buli"
import { BuliUiController } from "@/tui/ui-controller"
import { BuliUiControllerProvider } from "@/tui/ui-controller-state"

const WORKSPACE_ROOT = "/workspace"
const TEST_AGENT_ID = "test-agent"
const TEST_AGENTS = [{
  id: TEST_AGENT_ID,
  name: "Test Agent",
  systemPrompt: "System",
  tools: [],
}] as const

const APPLICATION_SNAPSHOT: IBuliApplicationSnapshot = {
  agents: [{ id: TEST_AGENT_ID, name: "Test Agent" }],
  defaultAgentId: TEST_AGENT_ID,
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

function codeRenderables(root: Renderable): CodeRenderable[] {
  return root.getChildren().flatMap((child) => [
    ...(child instanceof CodeRenderable ? [child] : []),
    ...codeRenderables(child),
  ])
}

function textareaRenderable(root: Renderable): TextareaRenderable {
  const textarea = findTextareaRenderable(root)
  if (textarea) return textarea
  throw new Error("Expected a textarea renderable")
}

function findTextareaRenderable(root: Renderable): TextareaRenderable | undefined {
  if (root instanceof TextareaRenderable) return root
  for (const child of root.getChildren()) {
    const textarea = findTextareaRenderable(child)
    if (textarea) return textarea
  }
  return undefined
}

interface IFakeApplicationOptions {
  readonly sessionSnapshot?: ISessionSnapshot
  readonly submitPrompt?: (prompt: IBuliPromptInput) => IBuliPromptSubmission
  readonly steer?: (sessionId: string, text: string) => void
  readonly followUp?: (sessionId: string, text: string) => void
  readonly clearQueuedMessages?: IBuliApplication["clearQueuedMessages"]
}

function fakeApplication(options: IFakeApplicationOptions = {}) {
  const prompts: IBuliPromptInput[] = []
  const steering: Array<{ sessionId: string; text: string }> = []
  const followUps: Array<{ sessionId: string; text: string }> = []
  const aborted: string[] = []
  const sessionListeners = new Set<() => void>()
  let sessionSnapshot: ISessionSnapshot = options.sessionSnapshot ?? {
    messages: [],
    pendingSteeringMessages: [],
    pendingFollowUpMessages: [],
    isRunning: false,
    pendingToolCallIds: [],
  }
  let runCount = 0
  const session = {
    subscribe: (listener: () => void) => {
      sessionListeners.add(listener)
      return () => sessionListeners.delete(listener)
    },
    getSnapshot: () => sessionSnapshot,
  }
  const application: IBuliApplication = {
    workspaceRoot: WORKSPACE_ROOT,
    subscribe: () => () => undefined,
    getSnapshot: () => APPLICATION_SNAPSHOT,
    selectModel: () => undefined,
    selectReasoningEffort: () => undefined,
    createSession: ({ agentId, title }) => ({
      id: "default",
      agentId,
      title,
      createdAt: 1,
      updatedAt: 1,
    }),
    openSession: () => session,
    listSessions: () => [],
    submitPrompt: (prompt) => {
      prompts.push(prompt)
      return options.submitPrompt?.(prompt) ?? {
        sessionId: prompt.sessionId ?? "default",
        runId: `run-${++runCount}`,
        accepted: Promise.resolve(),
        settled: Promise.resolve(),
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
      return options.clearQueuedMessages?.(sessionId) ?? {
        steering: [],
        followUp: [],
      }
    },
    clearSession: () => undefined,
    abort: async (sessionId) => {
      aborted.push(sessionId)
    },
    dispose: async () => undefined,
  }

  return {
    application,
    prompts,
    steering,
    followUps,
    aborted,
    setSessionSnapshot(snapshot: ISessionSnapshot) {
      sessionSnapshot = snapshot
      for (const listener of [...sessionListeners]) listener()
    },
  }
}

function buliElement(runtime: IBuliApplication, sessionId?: string) {
  const controller = new BuliUiController({
    application: runtime,
  })
  if (sessionId) controller.activateSession(sessionId)

  return buliElementWithController(runtime, controller)
}

function buliElementWithController(
  runtime: IBuliApplication,
  controller: BuliUiController,
) {
  return createElement(BuliRuntimeProvider, {
    runtime,
    children: createElement(BuliUiControllerProvider, {
      controller,
      children: createElement(BuliTui),
    }),
  })
}

test("provides the runtime above Buli", async () => {
  const { runtime } = await createBuliApplication({
    signal: new AbortController().signal,
    manager: new InMemorySessionManager(),
    model: { async *stream() {} },
    tools: [],
  })
  const setup = await testRender(
    buliElement(runtime),
    { width: 80, height: 24 },
  )

  try {
    expect(runtime.getSnapshot().agents).toEqual([{
      id: "buli",
      name: "Buli",
    }])

    await act(async () => {
      await setup.renderOnce()
    })
    const frame = setup.captureCharFrame()

    expect(frame.trim()).not.toBe("")
    expect(frame).not.toContain("Buli runtime not available")
    expect(frame).toContain("____")
    expect(runtime.listSessions()).toEqual([])
  } finally {
    await runtime.dispose()
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("Escape restores steering and aborts while chat input is focused", async () => {
  const fake = fakeApplication({
    clearQueuedMessages: () => ({
      steering: ["Queued steering"],
      followUp: ["Queued follow-up"],
    }),
  })
  const setup = await testRender(
    buliElement(fake.application, "default"),
    { width: 80, height: 24 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()
    })

    const escape = parseKeypress("\u001b")
    if (!escape) throw new Error("Expected Escape to parse as a keypress")

    await act(async () => {
      setup.renderer.keyInput.processParsedKey(escape)
      await setup.renderOnce()
    })

    expect(fake.aborted).toEqual(["default"])
    expect(textareaRenderable(setup.renderer.root).plainText).toBe(
      "Queued steering\n\nQueued follow-up",
    )
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("retains textarea input until acceptance and clears it afterward", async () => {
  const acceptance = Promise.withResolvers<void>()
  const fake = fakeApplication({
    submitPrompt: () => ({
      sessionId: "default",
      runId: "run-1",
      accepted: acceptance.promise,
      settled: acceptance.promise,
    }),
  })
  const setup = await testRender(
    buliElement(fake.application),
    { width: 80, height: 24 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()
      await setup.mockInput.typeText("Accepted prompt")
      setup.mockInput.pressEnter()
      await Promise.resolve()
      await setup.renderOnce()
    })

    expect(textareaRenderable(setup.renderer.root).plainText).toBe(
      "Accepted prompt",
    )

    await act(async () => {
      acceptance.resolve()
      await acceptance.promise
      await Promise.resolve()
      await setup.renderOnce()
    })

    expect(textareaRenderable(setup.renderer.root).plainText).toBe("")
    expect(fake.prompts).toEqual([{ text: "Accepted prompt" }])
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("preserves a replacement draft when a second submission is pending", async () => {
  const acceptance = Promise.withResolvers<void>()
  const fake = fakeApplication({
    submitPrompt: () => ({
      sessionId: "default",
      runId: "run-1",
      accepted: acceptance.promise,
      settled: acceptance.promise,
    }),
  })
  const setup = await testRender(
    buliElement(fake.application, "default"),
    { width: 80, height: 24 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()
      await setup.mockInput.typeText("First prompt")
      setup.mockInput.pressEnter()
      await Promise.resolve()
      await setup.renderOnce()
    })

    await act(async () => {
      const textarea = textareaRenderable(setup.renderer.root)
      textarea.clear()
      textarea.insertText("Replacement draft")
      await setup.renderOnce()
    })

    await act(async () => {
      const textarea = textareaRenderable(setup.renderer.root)
      textarea.submit()
      await Promise.resolve()
      await setup.renderOnce()
    })

    expect(fake.prompts).toEqual([{
      sessionId: "default",
      text: "First prompt",
    }])
    expect(textareaRenderable(setup.renderer.root).plainText).toBe(
      "Replacement draft",
    )
    expect(setup.captureCharFrame()).toContain(
      "Prompt submission is still pending",
    )

    await act(async () => {
      acceptance.resolve()
      await acceptance.promise
      await Promise.resolve()
      await setup.renderOnce()
    })

    expect(textareaRenderable(setup.renderer.root).plainText).toBe(
      "Replacement draft",
    )
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("restores a replacement Home draft after acceptance opens its session", async () => {
  const acceptance = Promise.withResolvers<void>()
  const fake = fakeApplication({
    submitPrompt: () => ({
      sessionId: "default",
      runId: "run-1",
      accepted: acceptance.promise,
      settled: acceptance.promise,
    }),
  })
  const controller = new BuliUiController({ application: fake.application })
  const setup = await testRender(
    buliElementWithController(fake.application, controller),
    { width: 80, height: 24 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()
      await setup.mockInput.typeText("First prompt")
      setup.mockInput.pressEnter()
      await Promise.resolve()
      await setup.renderOnce()
    })
    expect(controller.getSnapshot().route).toEqual({ type: "home" })

    await act(async () => {
      const textarea = textareaRenderable(setup.renderer.root)
      textarea.clear()
      textarea.insertText("Replacement draft")
      await setup.renderOnce()
    })
    expect(controller.getSnapshot().input).toBe("Replacement draft")

    await act(async () => {
      acceptance.resolve()
      await acceptance.promise
      await Promise.resolve()
      await setup.renderOnce()
      await Promise.resolve()
      await setup.renderOnce()
    })

    expect(controller.getSnapshot()).toMatchObject({
      route: { type: "session", sessionId: "default" },
      input: "Replacement draft",
    })
    expect(textareaRenderable(setup.renderer.root).plainText).toBe(
      "Replacement draft",
    )
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("retains textarea input when prompt acceptance fails", async () => {
  const acceptance = Promise.withResolvers<void>()
  const fake = fakeApplication({
    submitPrompt: () => ({
      sessionId: "default",
      runId: "run-1",
      accepted: acceptance.promise,
      settled: acceptance.promise,
    }),
  })
  const setup = await testRender(
    buliElement(fake.application),
    { width: 80, height: 24 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()
      await setup.mockInput.typeText("Unpersisted prompt")
      setup.mockInput.pressEnter()
      await Promise.resolve()
      acceptance.reject(new Error("Failed to persist prompt"))
      await Promise.resolve()
      await setup.renderOnce()
    })

    expect(textareaRenderable(setup.renderer.root).plainText).toBe(
      "Unpersisted prompt",
    )
    expect(setup.captureCharFrame()).toContain("Failed to persist prompt")
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("submits textarea input as steering while the session is running", async () => {
  const fake = fakeApplication({
    sessionSnapshot: {
      messages: [],
      pendingSteeringMessages: [],
      pendingFollowUpMessages: [],
      isRunning: true,
      activeRunId: "run-1",
      pendingToolCallIds: [],
    },
  })
  const setup = await testRender(
    buliElement(fake.application, "default"),
    { width: 80, height: 24 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()
      await setup.mockInput.typeText("Steering prompt")
      setup.mockInput.pressEnter()
      await Promise.resolve()
      await setup.renderOnce()
    })

    expect(fake.steering).toEqual([{
      sessionId: "default",
      text: "Steering prompt",
    }])
    expect(fake.prompts).toEqual([])
    expect(textareaRenderable(setup.renderer.root).plainText).toBe("")
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("submits Alt+Enter input as follow-up while the session is running", async () => {
  const fake = fakeApplication({
    sessionSnapshot: {
      messages: [],
      pendingSteeringMessages: [],
      pendingFollowUpMessages: [],
      isRunning: true,
      activeRunId: "run-1",
      pendingToolCallIds: [],
    },
  })
  const setup = await testRender(
    buliElement(fake.application, "default"),
    { width: 80, height: 24 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()
      await setup.mockInput.typeText("Follow-up prompt")
      setup.mockInput.pressEnter({ meta: true })
      await Promise.resolve()
      await setup.renderOnce()
    })

    expect(fake.followUps).toEqual([{
      sessionId: "default",
      text: "Follow-up prompt",
    }])
    expect(fake.steering).toEqual([])
    expect(fake.prompts).toEqual([])
    expect(textareaRenderable(setup.renderer.root).plainText).toBe("")
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("retains textarea input when a finishing run rejects steering", async () => {
  const fake = fakeApplication({
    sessionSnapshot: {
      messages: [],
      pendingSteeringMessages: [],
      pendingFollowUpMessages: [],
      isRunning: true,
      activeRunId: "run-1",
      pendingToolCallIds: [],
    },
    steer: () => {
      throw new Error("Agent is not accepting steering messages")
    },
  })
  const setup = await testRender(
    buliElement(fake.application, "default"),
    { width: 80, height: 24 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()
      await setup.mockInput.typeText("Queued prompt")
      setup.mockInput.pressEnter()
      await Promise.resolve()
      await setup.renderOnce()
    })

    expect(textareaRenderable(setup.renderer.root).plainText).toBe(
      "Queued prompt",
    )
    expect(setup.captureCharFrame()).toContain(
      "Agent is not accepting steering messages",
    )
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("renders running and failed session status", async () => {
  const fake = fakeApplication({
    sessionSnapshot: {
      messages: [],
      pendingSteeringMessages: [{
        id: "steering-1",
        sessionId: "default",
        runId: "run-1",
        role: "user",
        source: "steer",
        content: "Adjust the answer",
        createdAt: 1,
      }],
      pendingFollowUpMessages: [{
        id: "follow-up-1",
        sessionId: "default",
        runId: "run-1",
        role: "user",
        source: "followUp",
        content: "Then summarize it",
        createdAt: 2,
      }],
      isRunning: true,
      activeRunId: "run-1",
      pendingToolCallIds: [],
    },
  })
  const setup = await testRender(
    buliElement(fake.application, "default"),
    { width: 80, height: 24 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()
    })
    expect(setup.captureCharFrame()).toContain(
      "Working... Enter steer | Alt+Enter follow-up | Esc stop",
    )
    expect(setup.captureCharFrame()).toContain("Steering: Adjust the answer")
    expect(setup.captureCharFrame()).toContain("Follow-up: Then summarize it")
    expect(setup.captureCharFrame()).toContain("Esc restores queued input")

    await act(async () => {
      fake.setSessionSnapshot({
        messages: [],
        pendingSteeringMessages: [],
        pendingFollowUpMessages: [],
        isRunning: false,
        pendingToolCallIds: [],
        lastRunReason: "error",
        errorMessage: "Provider request failed",
      })
      await setup.renderOnce()
    })

    const frame = setup.captureCharFrame()
    expect(frame).not.toContain(
      "Working... Enter steer | Alt+Enter follow-up | Esc stop",
    )
    expect(frame).toContain("Provider request failed")
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("shows slash commands and executes the selected clear command", async () => {
  const runtime = new BuliApplicationRuntime({
    workspaceRoot: WORKSPACE_ROOT,
    manager: new InMemorySessionManager(),
    agents: TEST_AGENTS,
    defaultAgentId: TEST_AGENT_ID,
    models: [{
      id: "test",
      name: "Test",
      model: {
        async *stream() {
          yield { type: "finish", reason: "stop" }
        },
      },
      reasoningEfforts: ["medium"],
    }],
    selection: {
      modelId: "test",
      reasoningEffort: "medium",
    },
    generateId: () => "default",
  })
  const session = runtime.createSession({
    agentId: TEST_AGENT_ID,
    title: "Old prompt",
  })
  await runtime.submitPrompt({
    sessionId: session.id,
    text: "Old prompt",
  }).settled
  const setup = await testRender(
    buliElement(runtime, session.id),
    { width: 80, height: 24 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()

      const slash = parseKeypress("/")
      if (!slash) throw new Error("Expected slash to parse as a keypress")
      setup.renderer.keyInput.processParsedKey(slash)
      await setup.renderOnce()
    })

    const frame = setup.captureCharFrame()
    expect(frame).toContain("→ clear")

    await act(async () => {
      const enter = parseKeypress("\r")
      if (!enter) throw new Error("Expected Enter to parse as a keypress")
      setup.renderer.keyInput.processParsedKey(enter)
      await setup.renderOnce()
    })

    expect(runtime.openSession(session.id).getSnapshot().messages).toEqual([])
  } finally {
    await runtime.dispose()
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("selects a model from the picker and updates the status row", async () => {
  const model: IAgentModel = { async *stream() {} }
  const runtime = new BuliApplicationRuntime({
    workspaceRoot: WORKSPACE_ROOT,
    manager: new InMemorySessionManager(),
    agents: TEST_AGENTS,
    defaultAgentId: TEST_AGENT_ID,
    models: [
      {
        id: "test",
        name: "Test",
        model,
        reasoningEfforts: ["medium"],
      },
      {
        id: "other",
        name: "Other",
        model,
        reasoningEfforts: ["medium"],
      },
    ],
    selection: {
      modelId: "test",
      reasoningEffort: "medium",
    },
    generateId: () => "default",
  })
  const session = runtime.createSession({
    agentId: TEST_AGENT_ID,
    title: "Model picker",
  })
  const setup = await testRender(
    buliElement(runtime, session.id),
    { width: 80, height: 24 },
  )

  try {
    const slash = parseKeypress("/")
    const down = parseKeypress("\u001b[B")
    const enter = parseKeypress("\r")
    if (!slash || !down || !enter) {
      throw new Error("Expected picker keypresses to parse")
    }

    await act(async () => {
      await setup.renderOnce()
      setup.renderer.keyInput.processParsedKey(slash)
      await setup.renderOnce()
      setup.renderer.keyInput.processParsedKey(down)
      await setup.renderOnce()
      setup.renderer.keyInput.processParsedKey(enter)
      await Promise.resolve()
      await setup.renderOnce()
    })

    expect(setup.captureCharFrame()).toContain("→ Test")

    await act(async () => {
      setup.renderer.keyInput.processParsedKey(down)
      await setup.renderOnce()
      setup.renderer.keyInput.processParsedKey(enter)
      await Promise.resolve()
      await setup.renderOnce()
    })

    expect(runtime.getSnapshot().selection.modelId).toBe("other")
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Other")
    expect(frame).not.toContain("→ Other")
  } finally {
    await runtime.dispose()
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("renders a submitted prompt and streamed response", async () => {
  const model: IAgentModel = {
    async *stream() {
      yield { type: "text-start", id: "answer" }
      yield { type: "text-delta", id: "answer", delta: "Rendered response" }
      yield { type: "text-end", id: "answer" }
      yield { type: "finish", reason: "stop" }
    },
  }
  const runtime = new BuliApplicationRuntime({
    workspaceRoot: WORKSPACE_ROOT,
    manager: new InMemorySessionManager(),
    agents: TEST_AGENTS,
    defaultAgentId: TEST_AGENT_ID,
    models: [{
      id: "test",
      name: "Test",
      model,
      reasoningEfforts: ["medium"],
    }],
    selection: {
      modelId: "test",
      reasoningEffort: "medium",
    },
    generateId: () => "default",
  })
  const session = runtime.createSession({
    agentId: TEST_AGENT_ID,
    title: "Rendered prompt",
  })
  const setup = await testRender(
    buliElement(runtime, session.id),
    { width: 80, height: 24 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()
      await runtime.submitPrompt({
        sessionId: session.id,
        text: "Rendered prompt",
      }).settled
      await setup.renderOnce()
      await Promise.all(
        codeRenderables(setup.renderer.root).map((renderable) =>
          renderable.highlightingDone
        ),
      )
      await setup.renderOnce()
    })

    const frame = setup.captureCharFrame()
    expect(frame).toContain("Rendered prompt")
    expect(frame).toContain("Rendered response")
    expect(frame).toContain("model")
    expect(frame).toContain("Test")
    expect(frame).toContain("reasoning")
    expect(frame).toContain("medium")
  } finally {
    await runtime.dispose()
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("renders the sessions picker and switches transcripts", async () => {
  let sessionNumber = 0
  const runtime = new BuliApplicationRuntime({
    workspaceRoot: WORKSPACE_ROOT,
    manager: new InMemorySessionManager(),
    agents: TEST_AGENTS,
    defaultAgentId: TEST_AGENT_ID,
    models: [{
      id: "test",
      name: "Test",
      model: {
        async *stream() {
          yield { type: "finish", reason: "stop" }
        },
      },
      reasoningEfforts: ["medium"],
    }],
    selection: {
      modelId: "test",
      reasoningEffort: "medium",
    },
    generateId: () => `session-${++sessionNumber}`,
    now: () => sessionNumber,
  })
  const first = runtime.createSession({
    agentId: TEST_AGENT_ID,
    title: "First history",
  })
  await runtime.submitPrompt({
    sessionId: first.id,
    text: "First history",
  }).settled
  const second = runtime.createSession({
    agentId: TEST_AGENT_ID,
    title: "Second history",
  })
  await runtime.submitPrompt({
    sessionId: second.id,
    text: "Second history",
  }).settled
  const controller = new BuliUiController({ application: runtime })
  controller.activateSession(first.id)
  const setup = await testRender(
    buliElementWithController(runtime, controller),
    { width: 80, height: 24 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()
      await controller.submitInput("/sessions")
      await setup.renderOnce()
    })

    const pickerFrame = setup.captureCharFrame()
    expect(pickerFrame).toContain("First history")
    expect(pickerFrame).toContain("Second history")

    await act(async () => {
      controller.moveMenuSelection(-1)
      await controller.activateSelectedMenuItem()
      await setup.renderOnce()
    })

    const sessionFrame = setup.captureCharFrame()
    expect(sessionFrame).toContain("Second history")
    expect(controller.getSnapshot().route).toEqual({
      type: "session",
      sessionId: second.id,
    })
  } finally {
    await runtime.dispose()
    act(() => {
      setup.renderer.destroy()
    })
  }
})
