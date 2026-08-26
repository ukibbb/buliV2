import {
  type CliRenderer,
  type KeyEvent,
  type ParsedKey,
  type Renderable,
  RGBA,
  ScrollBoxRenderable,
  TextareaRenderable,
} from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { expect, test } from "bun:test"
import { act } from "react"

import type {
  IBuliApplication,
  IBuliApplicationSnapshot,
} from "@/app/contracts"
import { BuliRuntimeProvider } from "@/app/ui/context/application-context"
import { BuliUiControllerProvider } from "@/app/ui/context/ui-controller-context"
import {
  COMPLETION_NOTIFICATION_MIN_DURATION_MS,
  SessionScreen,
} from "@/app/ui/shell/SessionScreen"
import { BuliUiController } from "@/app/ui/ui-controller"
import type { ICommandToolApprovalRequest, IUserMessage } from "@/agent"
import type { ISessionSnapshot } from "@/sessions"
import { theme } from "@/terminal/theme"

const SESSION_ID = "session-screen-test"

const APPLICATION_SNAPSHOT: IBuliApplicationSnapshot = {
  agents: [{ id: "test-agent", name: "Test Agent" }],
  defaultAgentId: "test-agent",
  models: [{
    id: "test-model",
    name: "Test Model",
    reasoningEfforts: ["medium"],
  }],
  selection: {
    modelId: "test-model",
    reasoningEffort: "medium",
  },
}

const APPROVAL: ICommandToolApprovalRequest = {
  kind: "command",
  id: "approval",
  sessionId: SESSION_ID,
  runId: "run-approval",
  toolCallId: "tool-call",
  title: "Run checks",
  purpose: "Verify the change",
  command: "bun test",
  explanation: "Runs focused tests.",
  cwd: "/workspace",
  expectedOutcome: "Tests pass.",
  sideEffects: "None.",
  timeoutSeconds: 30,
}

function sessionSnapshot(
  overrides: Partial<ISessionSnapshot> = {},
): ISessionSnapshot {
  return {
    messages: [],
    pendingSteeringMessages: [],
    pendingFollowUpMessages: [],
    isRunning: false,
    isCompacting: false,
    pendingToolCallIds: [],
    ...overrides,
  }
}

function transcriptMessages(count: number): IUserMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`,
    sessionId: SESSION_ID,
    runId: "run-history",
    role: "user",
    source: "prompt",
    content: `Transcript line ${index}`,
    createdAt: index,
  }))
}

function createSessionHarness(initialSnapshot: ISessionSnapshot) {
  let snapshot = initialSnapshot
  const sessionListeners = new Set<() => void>()
  const session = {
    subscribe: (listener: () => void) => {
      sessionListeners.add(listener)
      return () => sessionListeners.delete(listener)
    },
    getSnapshot: () => snapshot,
  }
  const application: IBuliApplication = {
    workspaceRoot: "/workspace",
    subscribe: () => () => undefined,
    getSnapshot: () => APPLICATION_SNAPSHOT,
    refreshModels: async () => undefined,
    selectModel: () => undefined,
    selectReasoningEffort: () => undefined,
    submitPrompt: () => ({
      sessionId: SESSION_ID,
      runId: "submitted-run",
      accepted: Promise.resolve(),
      settled: Promise.resolve(),
    }),
    steer: () => undefined,
    followUp: () => undefined,
    clearQueuedMessages: () => ({ steering: [], followUp: [] }),
    resolveToolApproval: () => undefined,
    compactSession: async () => undefined,
    abort: async () => undefined,
    dispose: async () => undefined,
    createSession: ({ agentId, title }) => ({
      id: SESSION_ID,
      agentId,
      title,
      createdAt: 0,
      updatedAt: 0,
    }),
    openSession: () => session,
    listSessions: () => [],
  }
  const controller = new BuliUiController({ application })
  controller.activateSession(SESSION_ID)

  return {
    application,
    controller,
    getSnapshot: () => snapshot,
    setSnapshot(nextSnapshot: ISessionSnapshot): void {
      snapshot = nextSnapshot
      for (const listener of [...sessionListeners]) listener()
    },
  }
}

function sessionElement(
  harness: ReturnType<typeof createSessionHarness>,
  now?: () => number,
) {
  return (
    <BuliRuntimeProvider runtime={harness.application}>
      <BuliUiControllerProvider controller={harness.controller}>
        <SessionScreen
          sessionId={SESSION_ID}
          {...(now ? { now } : {})}
        />
      </BuliUiControllerProvider>
    </BuliRuntimeProvider>
  )
}

test("configures a culled sticky transcript with restrained mouse scrolling", async () => {
  const messages = transcriptMessages(40)
  const harness = createSessionHarness(sessionSnapshot({ messages }))
  const setup = await testRender(sessionElement(harness), {
    width: 60,
    height: 18,
  })

  try {
    await act(async () => {
      await setup.renderOnce()
    })

    const transcript = scrollBoxRenderable(setup.renderer.root)
    const initialMaximum = maximumScrollTop(transcript)
    expect(transcript.viewportCulling).toBe(true)
    expect(transcript.stickyScroll).toBe(true)
    expect(transcript.stickyStart).toBe("bottom")
    expect(transcript.verticalScrollBar.showArrows).toBe(false)
    expect(transcript.verticalScrollBar.width).toBe(1)
    expect(transcript.verticalScrollBar.slider.backgroundColor.equals(
      RGBA.fromHex(theme.surface),
    )).toBe(true)
    expect(transcript.verticalScrollBar.slider.foregroundColor.equals(
      RGBA.fromHex(theme.textMuted),
    )).toBe(true)
    expect(initialMaximum).toBeGreaterThan(0)
    expect(transcript.scrollTop).toBe(initialMaximum)

    await act(async () => {
      harness.setSnapshot(sessionSnapshot({
        messages: [...messages, ...transcriptMessages(1).map((message) => ({
          ...message,
          id: "new-message",
          content: "New sticky transcript line",
        }))],
      }))
      await setup.renderOnce()
    })
    const expandedMaximum = maximumScrollTop(transcript)
    expect(expandedMaximum).toBeGreaterThan(initialMaximum)
    expect(transcript.scrollTop).toBe(expandedMaximum)

    await act(async () => {
      await setup.mockMouse.scroll(
        transcript.x + 1,
        transcript.y + 1,
        "up",
      )
      await setup.renderOnce()
    })
    expect(transcript.scrollTop).toBeLessThan(expandedMaximum)
  } finally {
    harness.controller.dispose()
    act(() => setup.renderer.destroy())
  }
})

test("navigates only modified transcript keys and drops a stale approval ref", async () => {
  const harness = createSessionHarness(sessionSnapshot({
    messages: transcriptMessages(40),
  }))
  const setup = await testRender(sessionElement(harness), {
    width: 60,
    height: 18,
  })

  try {
    await act(async () => {
      await setup.renderOnce()
      await setup.mockInput.typeText("draft")
      await setup.renderOnce()
    })
    const transcript = scrollBoxRenderable(setup.renderer.root)
    const editor = textareaRenderable(setup.renderer.root)
    const initialTranscriptTop = transcript.scrollTop
    expect(initialTranscriptTop).toBeGreaterThan(0)
    expect(editor.cursorOffset).toBe(5)

    pressKey(setup.renderer, "home")
    expect(editor.cursorOffset).toBe(0)
    expect(transcript.scrollTop).toBe(initialTranscriptTop)
    pressKey(setup.renderer, "end")
    pressKey(setup.renderer, "pageup")
    pressKey(setup.renderer, "pagedown")
    expect(editor.cursorOffset).toBe(5)
    expect(transcript.scrollTop).toBe(initialTranscriptTop)

    const home = pressKey(setup.renderer, "home", { meta: true })
    expect(home.defaultPrevented).toBe(true)
    expect(home.propagationStopped).toBe(true)
    expect(transcript.scrollTop).toBe(0)

    const pageDown = pressKey(setup.renderer, "pagedown", { meta: true })
    expect(pageDown.defaultPrevented).toBe(true)
    expect(pageDown.propagationStopped).toBe(true)
    expect(transcript.scrollTop).toBeGreaterThan(0)
    const pageDownTop = transcript.scrollTop

    const pageUp = pressKey(setup.renderer, "pageup", { meta: true })
    expect(pageUp.defaultPrevented).toBe(true)
    expect(pageUp.propagationStopped).toBe(true)
    expect(transcript.scrollTop).toBeLessThan(pageDownTop)

    const end = pressKey(setup.renderer, "end", {
      meta: true,
      option: true,
    })
    expect(end.defaultPrevented).toBe(true)
    expect(end.propagationStopped).toBe(true)
    expect(transcript.scrollTop).toBe(maximumScrollTop(transcript))

    const unhandled = pressKey(setup.renderer, "f12", { meta: true })
    expect(unhandled.defaultPrevented).toBe(false)
    expect(unhandled.propagationStopped).toBe(false)

    let staleScrollCalls = 0
    transcript.scrollTo = () => {
      staleScrollCalls += 1
    }
    await act(async () => {
      harness.setSnapshot(sessionSnapshot({
        isRunning: true,
        activeRunId: APPROVAL.runId,
        pendingToolCallIds: [APPROVAL.toolCallId],
        pendingToolApproval: APPROVAL,
      }))
      await setup.renderOnce()
    })
    expect(findScrollBoxRenderable(setup.renderer.root)).toBeUndefined()

    const approvalKey = pressKey(setup.renderer, "home", { meta: true })
    expect(staleScrollCalls).toBe(0)
    expect(approvalKey.defaultPrevented).toBe(false)
    expect(approvalKey.propagationStopped).toBe(false)
  } finally {
    harness.controller.dispose()
    act(() => setup.renderer.destroy())
  }
})

test("notifies only for long runs completed while the terminal is blurred", async () => {
  let currentTime = 0
  const harness = createSessionHarness(sessionSnapshot({
    isRunning: true,
    activeRunId: "initial-run",
  }))
  const setup = await testRender(
    sessionElement(harness, () => currentTime),
    { width: 60, height: 18 },
  )
  const notifications: Array<{ message: string; title?: string }> = []
  setup.renderer.triggerNotification = (message, title) => {
    notifications.push({ message, ...(title === undefined ? {} : { title }) })
    return false
  }

  try {
    await act(async () => {
      await setup.renderOnce()
    })
    expect(notifications).toEqual([])

    act(() => {
      setup.renderer.emit("blur")
    })
    currentTime = COMPLETION_NOTIFICATION_MIN_DURATION_MS - 1
    await updateRunning(harness, setup, false)
    expect(notifications).toEqual([])

    act(() => {
      setup.renderer.emit("focus")
    })
    currentTime = 10_000
    await updateRunning(harness, setup, true)
    currentTime += COMPLETION_NOTIFICATION_MIN_DURATION_MS
    await updateRunning(harness, setup, false)
    expect(notifications).toEqual([])

    act(() => {
      setup.renderer.emit("blur")
    })
    currentTime = 20_000
    await updateRunning(harness, setup, true)
    currentTime += COMPLETION_NOTIFICATION_MIN_DURATION_MS
    await updateRunning(harness, setup, false)
    expect(notifications).toEqual([{
      message: "Run finished",
      title: "Buli",
    }])
  } finally {
    harness.controller.dispose()
    act(() => setup.renderer.destroy())
  }
})

async function updateRunning(
  harness: ReturnType<typeof createSessionHarness>,
  setup: Awaited<ReturnType<typeof testRender>>,
  isRunning: boolean,
): Promise<void> {
  await act(async () => {
    harness.setSnapshot({
      ...harness.getSnapshot(),
      isRunning,
      ...(isRunning ? { activeRunId: "active-run" } : {}),
    })
    await setup.renderOnce()
  })
}

function pressKey(
  renderer: CliRenderer,
  name: string,
  modifiers: { meta?: boolean; option?: boolean } = {},
): KeyEvent {
  let captured: KeyEvent | undefined
  const capture = (key: KeyEvent): void => {
    captured = key
  }
  renderer.keyInput.prependListener("keypress", capture)
  const key: ParsedKey = {
    name,
    ctrl: false,
    meta: modifiers.meta ?? false,
    shift: false,
    option: modifiers.option ?? false,
    sequence: "",
    number: false,
    raw: "",
    eventType: "press",
    source: modifiers.option ? "kitty" : "raw",
  }
  try {
    renderer.keyInput.processParsedKey(key)
  } finally {
    renderer.keyInput.off("keypress", capture)
  }
  if (!captured) throw new Error(`Expected ${name} key event`)
  return captured
}

function scrollBoxRenderable(root: Renderable): ScrollBoxRenderable {
  const transcript = findScrollBoxRenderable(root)
  if (transcript) return transcript
  throw new Error("Expected session transcript scrollbox")
}

function findScrollBoxRenderable(
  root: Renderable,
): ScrollBoxRenderable | undefined {
  if (root instanceof ScrollBoxRenderable && root.id === "session-transcript") {
    return root
  }
  for (const child of root.getChildren()) {
    const transcript = findScrollBoxRenderable(child)
    if (transcript) return transcript
  }
  return undefined
}

function textareaRenderable(root: Renderable): TextareaRenderable {
  if (root instanceof TextareaRenderable) return root
  for (const child of root.getChildren()) {
    try {
      return textareaRenderable(child)
    } catch {
      // Continue through the remaining render tree.
    }
  }
  throw new Error("Expected chat textarea")
}

function maximumScrollTop(scrollbox: ScrollBoxRenderable): number {
  return Math.max(0, scrollbox.scrollHeight - scrollbox.viewport.height)
}
