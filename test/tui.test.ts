import { expect, test } from "bun:test"
import {
  BoxRenderable,
  CodeRenderable,
  parseKeypress,
  type Renderable,
  ScrollBoxRenderable,
  TextRenderable,
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
import type { IAuthenticationService } from "@/auth/contracts"
import { BuliApplicationRuntime } from "@/application/runtime"
import { BuliRuntimeProvider } from "@/tui/app/application-context"
import type { IAgentModel } from "@/agent/agent-types"
import type {
  ICommandToolApprovalRequest,
  IPatchToolApprovalRequest,
  ISessionSnapshot,
  TToolApprovalDecision,
  TToolApprovalRequest,
  IUserMessage,
} from "@/domain"
import { InMemorySessionManager } from "@/session/session-manager"
import { BuliTui } from "@/tui/app/BuliTui"
import { BuliUiController } from "@/tui/app/ui-controller"
import { BuliUiControllerProvider } from "@/tui/app/ui-controller-context"

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

const AUTHENTICATION: IAuthenticationService = {
  listProviders: async () => [],
  login: async () => {
    throw new Error("No authentication provider configured for this test")
  },
  logout: async () => false,
  dispose: async () => {},
}

function codeRenderables(root: Renderable): CodeRenderable[] {
  return root.getChildren().flatMap((child) => [
    ...(child instanceof CodeRenderable ? [child] : []),
    ...codeRenderables(child),
  ])
}

function textRenderables(root: Renderable): TextRenderable[] {
  return root.getChildren().flatMap((child) => [
    ...(child instanceof TextRenderable ? [child] : []),
    ...textRenderables(child),
  ])
}

function scrollBoxRenderable(root: Renderable, id: string): ScrollBoxRenderable {
  const scrollBox = findScrollBoxRenderable(root, id)
  if (scrollBox) return scrollBox
  throw new Error(`Expected scrollbox ${id}`)
}

function findScrollBoxRenderable(
  root: Renderable,
  id: string,
): ScrollBoxRenderable | undefined {
  if (root instanceof ScrollBoxRenderable && root.id === id) return root
  for (const child of root.getChildren()) {
    const scrollBox = findScrollBoxRenderable(child, id)
    if (scrollBox) return scrollBox
  }
  return undefined
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
  readonly resolveToolApproval?: IBuliApplication["resolveToolApproval"]
}

function fakeApplication(options: IFakeApplicationOptions = {}) {
  const prompts: IBuliPromptInput[] = []
  const steering: Array<{ sessionId: string; text: string }> = []
  const followUps: Array<{ sessionId: string; text: string }> = []
  const resolvedApprovals: Array<{
    sessionId: string
    approvalId: string
    decision: TToolApprovalDecision
  }> = []
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
    resolveToolApproval: (sessionId, approvalId, decision) => {
      options.resolveToolApproval?.(sessionId, approvalId, decision)
      resolvedApprovals.push({ sessionId, approvalId, decision })
    },
    clearSession: () => undefined,
    compactSession: async () => undefined,
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
    resolvedApprovals,
    aborted,
    setSessionSnapshot(snapshot: ISessionSnapshot) {
      sessionSnapshot = snapshot
      for (const listener of [...sessionListeners]) listener()
    },
  }
}

function patchApproval(): IPatchToolApprovalRequest {
  return {
    kind: "patch",
    id: "patch-approval",
    sessionId: "default",
    runId: "run-1",
    toolCallId: "patch-call",
    title: "Update greeting",
    explanation: "Replace the old greeting while preserving the fallback.",
    paths: ["src/greeting.ts", "test/greeting.test.ts"],
    diff: [
      "diff --git a/src/greeting.ts b/src/greeting.ts",
      "--- a/src/greeting.ts",
      "+++ b/src/greeting.ts",
      "@@ -1 +1 @@",
      "-export const greeting = 'old'",
      "+export const greeting = 'new'",
    ].join("\n"),
  }
}

function commandApproval(): ICommandToolApprovalRequest {
  return {
    kind: "command",
    id: "command-approval",
    sessionId: "default",
    runId: "run-1",
    toolCallId: "command-call",
    title: "Verify the implementation",
    purpose: "Run focused tests and then check TypeScript.",
    command: "bun test test/tui.test.ts && bun run typecheck",
    explanation:
      "bun test runs the UI tests; && continues on success; bun run typecheck checks types.",
    cwd: "/workspace/project",
    expectedOutcome: "All UI tests pass and TypeScript reports no errors.",
    sideEffects: "May create temporary test caches in the workspace.",
    timeoutSeconds: 120,
  }
}

function approvalSessionSnapshot(
  pendingToolApproval: TToolApprovalRequest,
): ISessionSnapshot {
  return {
    messages: [],
    pendingSteeringMessages: [],
    pendingFollowUpMessages: [],
    pendingToolApproval,
    isRunning: true,
    activeRunId: "run-1",
    pendingToolCallIds: [pendingToolApproval.toolCallId],
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
      children: createElement(BuliTui, {
        authentication: AUTHENTICATION,
        openUrl: () => {},
      }),
    }),
  })
}

test("provides the runtime above Buli", async () => {
  const startup = await createBuliApplication({
    signal: new AbortController().signal,
    manager: new InMemorySessionManager(),
    model: { async *stream() {} },
    tools: [],
  })
  const { runtime } = startup
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
    await startup.dispose()
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

test("preserves the chat draft while authentication opens and closes", async () => {
  const fake = fakeApplication()
  const controller = new BuliUiController({ application: fake.application })
  controller.updateInput("Unsent draft")
  const setup = await testRender(
    buliElementWithController(fake.application, controller),
    { width: 80, height: 24 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()
    })
    expect(textareaRenderable(setup.renderer.root).plainText).toBe("Unsent draft")

    await act(async () => {
      controller.openAuthentication("login")
      await Promise.resolve()
      await setup.renderOnce()
    })
    expect(setup.captureCharFrame()).toContain("Buli Authentication")
    expect(controller.getSnapshot().input).toBe("Unsent draft")

    await act(async () => {
      controller.closeAuthentication()
      await setup.renderOnce()
    })
    expect(textareaRenderable(setup.renderer.root).plainText).toBe("Unsent draft")
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

test("renders complete patch approval details and patch-only actions", async () => {
  const approval = patchApproval()
  const fake = fakeApplication({
    sessionSnapshot: approvalSessionSnapshot(approval),
  })
  const setup = await testRender(
    buliElement(fake.application, "default"),
    { width: 100, height: 48 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()
    })

    const frame = setup.captureCharFrame()
    const renderedText = textRenderables(setup.renderer.root).map(
      (renderable) => renderable.plainText,
    )
    expect(frame).toContain("Patch approval")
    expect(frame).toContain(approval.title)
    expect(frame).toContain(approval.explanation)
    expect(frame).toContain("Affected paths")
    expect(frame).toContain("src/greeting.ts")
    expect(frame).toContain("test/greeting.test.ts")
    expect(renderedText).toContain(approval.diff)
    expect(renderedText).toContain("> Reject")
    expect(renderedText).toContain("  Apply")
    expect(renderedText.indexOf("> Reject")).toBeLessThan(
      renderedText.indexOf("  Apply"),
    )
    expect(renderedText).not.toContain("  Copy")
    expect(frame).toContain(
      "PageUp/PageDown review | Arrows select | Enter confirm | Esc stop",
    )
    expect(frame).toContain("Waiting for your decision")
    expect(frame).not.toContain("Working... Enter steer")
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("renders complete command approval details and command actions", async () => {
  const approval = commandApproval()
  const fake = fakeApplication({
    sessionSnapshot: approvalSessionSnapshot(approval),
  })
  const setup = await testRender(
    buliElement(fake.application, "default"),
    { width: 100, height: 52 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()
    })

    const frame = setup.captureCharFrame()
    const renderedText = textRenderables(setup.renderer.root).map(
      (renderable) => renderable.plainText,
    )
    expect(frame).toContain("Command approval")
    expect(frame).toContain(approval.title)
    expect(frame).toContain(approval.purpose)
    expect(renderedText).toContain(approval.command)
    expect(frame).toContain(approval.explanation)
    expect(frame).toContain(approval.cwd)
    expect(frame).toContain(`${approval.timeoutSeconds} seconds`)
    expect(frame).toContain(approval.expectedOutcome)
    expect(frame).toContain(approval.sideEffects)
    expect(frame).toContain("Not sandboxed")
    expect(renderedText).toContain("> Copy")
    expect(renderedText).toContain("  Run once")
    expect(renderedText).toContain("  Reject")
    expect(renderedText.indexOf("> Copy")).toBeLessThan(
      renderedText.indexOf("  Run once"),
    )
    expect(renderedText.indexOf("  Run once")).toBeLessThan(
      renderedText.indexOf("  Reject"),
    )
    expect(frame).toContain(
      "PageUp/PageDown review | Arrows select | Enter confirm | Esc stop",
    )
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("keeps approval reviewable with many queued messages on a short terminal", async () => {
  const approval = commandApproval()
  const queuedSteering = Array.from({ length: 6 }, (_, index) => ({
    id: `queued-steering-${index}`,
    sessionId: "default",
    runId: "run-1",
    role: "user" as const,
    source: "steer" as const,
    content: `LONG QUEUED STEERING ${index}`,
    createdAt: index + 1,
  }))
  const queuedFollowUp = Array.from({ length: 6 }, (_, index) => ({
    id: `queued-follow-up-${index}`,
    sessionId: "default",
    runId: "run-1",
    role: "user" as const,
    source: "followUp" as const,
    content: `LONG QUEUED FOLLOW-UP ${index}`,
    createdAt: index + 10,
  }))
  const fake = fakeApplication({
    sessionSnapshot: {
      ...approvalSessionSnapshot(approval),
      pendingSteeringMessages: queuedSteering,
      pendingFollowUpMessages: queuedFollowUp,
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

    const frame = setup.captureCharFrame()
    expect(frame).toContain("Command approval")
    expect(frame).toContain("> Copy")
    expect(frame).toContain("Queued: 6 steering, 6 follow-up")
    expect(frame).not.toContain("LONG QUEUED STEERING")
    expect(frame).not.toContain("LONG QUEUED FOLLOW-UP")
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("reviews a tall patch from the top without changing its action", async () => {
  const approval: IPatchToolApprovalRequest = {
    ...patchApproval(),
    diff: [
      "diff --git a/src/long.ts b/src/long.ts",
      "REVIEW TOP",
      ...Array.from(
        { length: 80 },
        (_, index) => `+review-line-${String(index).padStart(3, "0")}`,
      ),
      "REVIEW END",
    ].join("\n"),
  }
  const fake = fakeApplication({
    sessionSnapshot: approvalSessionSnapshot(approval),
  })
  const setup = await testRender(
    buliElement(fake.application, "default"),
    { width: 80, height: 30 },
  )
  const pageDown = parseKeypress("\u001b[6~")
  const pageUp = parseKeypress("\u001b[5~")
  const end = parseKeypress("\u001b[F")
  const home = parseKeypress("\u001b[H")
  const right = parseKeypress("\u001b[C")
  const enter = parseKeypress("\r")
  if (!pageDown || !pageUp || !end || !home || !right || !enter) {
    throw new Error("Expected approval keys to parse")
  }

  try {
    await act(async () => {
      await setup.renderOnce()
    })

    const details = scrollBoxRenderable(
      setup.renderer.root,
      "tool-approval-details",
    )
    const initialFrame = setup.captureCharFrame()
    expect(details.scrollTop).toBe(0)
    expect(initialFrame).toContain("Patch approval")
    expect(initialFrame).toContain(approval.title)
    expect(initialFrame).toContain("REVIEW TOP")
    expect(initialFrame).not.toContain("REVIEW END")
    expect(initialFrame).toContain("> Reject")
    expect(initialFrame).toContain("PageUp/PageDown review")
    expect(setup.renderer.currentFocusedRenderable?.id).toBe(
      "tool-approval-panel",
    )

    await act(async () => {
      setup.renderer.keyInput.processParsedKey(pageDown)
      await setup.renderOnce()
    })

    const scrolledFrame = setup.captureCharFrame()
    const laterLine = scrolledFrame.match(/review-line-(\d{3})/)
    expect(details.scrollTop).toBeGreaterThan(0)
    expect(laterLine).not.toBeNull()
    if (!laterLine) throw new Error("Expected later diff content")
    expect(Number(laterLine[1])).toBeGreaterThan(0)
    expect(initialFrame).not.toContain(laterLine[0])
    expect(scrolledFrame).toContain("> Reject")
    expect(scrolledFrame).toContain("PageUp/PageDown review")
    expect(fake.resolvedApprovals).toEqual([])
    expect(setup.renderer.currentFocusedRenderable?.id).toBe(
      "tool-approval-panel",
    )

    await act(async () => {
      setup.renderer.keyInput.processParsedKey(pageUp)
      await setup.renderOnce()
    })

    const returnedFrame = setup.captureCharFrame()
    expect(details.scrollTop).toBe(0)
    expect(returnedFrame).toContain("Patch approval")
    expect(returnedFrame).toContain("REVIEW TOP")
    expect(returnedFrame).toContain("> Reject")
    expect(fake.resolvedApprovals).toEqual([])
    expect(setup.renderer.currentFocusedRenderable?.id).toBe(
      "tool-approval-panel",
    )

    await act(async () => {
      setup.renderer.keyInput.processParsedKey(end)
      await setup.renderOnce()
    })
    expect(details.scrollTop).toBeGreaterThan(0)
    expect(setup.captureCharFrame()).toContain("REVIEW END")
    expect(setup.captureCharFrame()).toContain("> Reject")
    expect(fake.resolvedApprovals).toEqual([])

    await act(async () => {
      setup.renderer.keyInput.processParsedKey(home)
      await setup.renderOnce()
    })
    expect(details.scrollTop).toBe(0)
    expect(setup.captureCharFrame()).toContain("REVIEW TOP")

    act(() => {
      setup.renderer.keyInput.processParsedKey(right)
    })
    await act(async () => {
      await setup.renderOnce()
    })
    expect(setup.captureCharFrame()).toContain("> Apply")
    expect(fake.resolvedApprovals).toEqual([])

    await act(async () => {
      setup.renderer.keyInput.processParsedKey(enter)
      await setup.renderOnce()
    })
    expect(fake.resolvedApprovals).toEqual([{
      sessionId: "default",
      approvalId: approval.id,
      decision: "approve",
    }])
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("focuses approval and ignores printable keys and chat submission", async () => {
  const approval = commandApproval()
  const transcriptMessage: IUserMessage = {
    id: "transcript-message",
    sessionId: "default",
    runId: "run-1",
    role: "user",
    source: "prompt",
    content: "Transcript returns after approval",
    createdAt: 1,
  }
  const fake = fakeApplication({
    sessionSnapshot: {
      ...approvalSessionSnapshot(approval),
      messages: [transcriptMessage],
    },
  })
  const controller = new BuliUiController({ application: fake.application })
  controller.activateSession("default")
  controller.updateInput("Draft y/n/c stays exactly")
  const setup = await testRender(
    buliElementWithController(fake.application, controller),
    { width: 80, height: 42 },
  )
  const copied: string[] = []
  setup.renderer.copyToClipboardOSC52 = (text) => {
    copied.push(text)
    return true
  }

  try {
    await act(async () => {
      await setup.renderOnce()
    })

    const textarea = textareaRenderable(setup.renderer.root)
    expect(textarea.focused).toBe(false)
    expect(setup.renderer.currentFocusedRenderable).toBeInstanceOf(BoxRenderable)
    expect(setup.renderer.currentFocusedRenderable?.id).toBe("tool-approval-panel")
    expect(setup.captureCharFrame()).not.toContain(transcriptMessage.content)

    await act(async () => {
      await setup.mockInput.typeText("ync ordinary text")
      textarea.submit()
      setup.mockInput.pressEnter({ meta: true })
      await setup.renderOnce()
    })

    expect(copied).toEqual([])
    expect(fake.resolvedApprovals).toEqual([])
    expect(fake.prompts).toEqual([])
    expect(fake.steering).toEqual([])
    expect(fake.followUps).toEqual([])
    expect(controller.getSnapshot().input).toBe("Draft y/n/c stays exactly")
    expect(textarea.plainText).toBe(
      "Draft y/n/c stays exactly",
    )

    await act(async () => {
      fake.setSessionSnapshot({
        messages: [transcriptMessage],
        pendingSteeringMessages: [],
        pendingFollowUpMessages: [],
        isRunning: true,
        activeRunId: "run-1",
        pendingToolCallIds: [],
      })
      await setup.renderOnce()
    })
    expect(textarea.focused).toBe(true)
    expect(setup.renderer.currentFocusedRenderable).toBe(textarea)
    expect(textarea.plainText).toBe("Draft y/n/c stays exactly")
    expect(setup.captureCharFrame()).toContain(transcriptMessage.content)
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("defaults patch Enter to Reject without consuming the draft", async () => {
  const approval = patchApproval()
  const fake = fakeApplication({
    sessionSnapshot: approvalSessionSnapshot(approval),
  })
  const controller = new BuliUiController({ application: fake.application })
  controller.activateSession("default")
  controller.updateInput("Patch draft remains")
  const setup = await testRender(
    buliElementWithController(fake.application, controller),
    { width: 80, height: 42 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()
      setup.mockInput.pressEnter()
      await setup.renderOnce()
    })

    expect(fake.resolvedApprovals).toEqual([{
      sessionId: "default",
      approvalId: approval.id,
      decision: "reject",
    }])
    expect(fake.steering).toEqual([])
    expect(controller.getSnapshot().input).toBe("Patch draft remains")
    expect(textareaRenderable(setup.renderer.root).plainText).toBe(
      "Patch draft remains",
    )
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("defaults command Enter to Copy and resolves only after clipboard success", async () => {
  const approval = commandApproval()
  const fake = fakeApplication({
    sessionSnapshot: approvalSessionSnapshot(approval),
  })
  const controller = new BuliUiController({ application: fake.application })
  controller.activateSession("default")
  controller.updateInput("Command draft remains")
  const setup = await testRender(
    buliElementWithController(fake.application, controller),
    { width: 80, height: 44 },
  )
  const copied: string[] = []
  setup.renderer.copyToClipboardOSC52 = (text) => {
    copied.push(text)
    return true
  }

  try {
    await act(async () => {
      await setup.renderOnce()
      setup.mockInput.pressEnter()
      await setup.renderOnce()
    })

    expect(copied).toEqual([approval.command])
    expect(fake.resolvedApprovals).toEqual([{
      sessionId: "default",
      approvalId: approval.id,
      decision: "copy",
    }])
    expect(fake.steering).toEqual([])
    expect(controller.getSnapshot().input).toBe("Command draft remains")
    expect(textareaRenderable(setup.renderer.root).plainText).toBe(
      "Command draft remains",
    )
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

for (const approvalCase of [
  {
    name: "Right then Enter applies a patch",
    approval: patchApproval(),
    direction: "right",
    selectedLabel: "> Apply",
    decision: "approve",
  },
  {
    name: "Down then Enter runs a command once",
    approval: commandApproval(),
    direction: "down",
    selectedLabel: "> Run once",
    decision: "approve",
  },
  {
    name: "Left then Enter rejects a command",
    approval: commandApproval(),
    direction: "left",
    selectedLabel: "> Reject",
    decision: "reject",
  },
] as const) {
  test(approvalCase.name, async () => {
    const fake = fakeApplication({
      sessionSnapshot: approvalSessionSnapshot(approvalCase.approval),
    })
    const controller = new BuliUiController({ application: fake.application })
    controller.activateSession("default")
    controller.updateInput("Navigation keeps this draft")
    const setup = await testRender(
      buliElementWithController(fake.application, controller),
      { width: 80, height: 44 },
    )
    const copied: string[] = []
    setup.renderer.copyToClipboardOSC52 = (text) => {
      copied.push(text)
      return true
    }

    try {
      await act(async () => {
        await setup.renderOnce()
        setup.mockInput.pressArrow(approvalCase.direction)
        await setup.renderOnce()
      })
      expect(textRenderables(setup.renderer.root).map((item) => item.plainText))
        .toContain(approvalCase.selectedLabel)

      await act(async () => {
        setup.mockInput.pressEnter()
        await setup.renderOnce()
      })

      expect(copied).toEqual([])
      expect(fake.resolvedApprovals).toEqual([{
        sessionId: "default",
        approvalId: approvalCase.approval.id,
        decision: approvalCase.decision,
      }])
      expect(fake.steering).toEqual([])
      expect(controller.getSnapshot().input).toBe("Navigation keeps this draft")
      expect(textareaRenderable(setup.renderer.root).plainText).toBe(
        "Navigation keeps this draft",
      )
    } finally {
      act(() => {
        setup.renderer.destroy()
      })
    }
  })
}

test("resets command selection to Copy when the approval ID changes", async () => {
  const firstApproval = commandApproval()
  const secondApproval: ICommandToolApprovalRequest = {
    ...commandApproval(),
    id: "command-approval-2",
    toolCallId: "command-call-2",
    command: "bun test test/keyboard-shortcuts.test.ts",
  }
  const fake = fakeApplication({
    sessionSnapshot: approvalSessionSnapshot(firstApproval),
  })
  const controller = new BuliUiController({ application: fake.application })
  controller.activateSession("default")
  const setup = await testRender(
    buliElementWithController(fake.application, controller),
    { width: 80, height: 44 },
  )
  const copied: string[] = []
  setup.renderer.copyToClipboardOSC52 = (text) => {
    copied.push(text)
    return true
  }

  try {
    await act(async () => {
      await setup.renderOnce()
      setup.mockInput.pressArrow("down")
      await setup.renderOnce()
    })
    expect(textRenderables(setup.renderer.root).map((item) => item.plainText))
      .toContain("> Run once")

    await act(async () => {
      fake.setSessionSnapshot(approvalSessionSnapshot(secondApproval))
      await setup.renderOnce()
    })
    expect(textRenderables(setup.renderer.root).map((item) => item.plainText))
      .toContain("> Copy")

    await act(async () => {
      setup.mockInput.pressEnter()
      await setup.renderOnce()
    })

    expect(copied).toEqual([secondApproval.command])
    expect(fake.resolvedApprovals).toEqual([{
      sessionId: "default",
      approvalId: secondApproval.id,
      decision: "copy",
    }])
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("keeps command approval pending when default Copy is unavailable", async () => {
  const approval = commandApproval()
  const fake = fakeApplication({
    sessionSnapshot: approvalSessionSnapshot(approval),
  })
  const controller = new BuliUiController({ application: fake.application })
  controller.activateSession("default")
  controller.updateInput("Still preserved")
  const setup = await testRender(
    buliElementWithController(fake.application, controller),
    { width: 80, height: 44 },
  )
  setup.renderer.copyToClipboardOSC52 = () => false

  try {
    await act(async () => {
      await setup.renderOnce()
      setup.mockInput.pressEnter()
      await setup.renderOnce()
    })

    expect(fake.resolvedApprovals).toEqual([])
    expect(fake.application.openSession("default").getSnapshot().pendingToolApproval)
      .toBe(approval)
    expect(controller.getSnapshot()).toMatchObject({
      input: "Still preserved",
      inputError: "Clipboard copy is not supported by this terminal",
    })
    expect(setup.captureCharFrame()).toContain(
      "Clipboard copy is not supported by this terminal",
    )
    expect(textareaRenderable(setup.renderer.root).plainText).toBe(
      "Still preserved",
    )
    expect(setup.renderer.currentFocusedRenderable?.id).toBe("tool-approval-panel")
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
