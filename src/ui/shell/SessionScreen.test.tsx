import {
  type CliRenderer,
  CodeRenderable,
  DiffRenderable,
  type KeyEvent,
  MarkdownRenderable,
  type ParsedKey,
  type Renderable,
  RGBA,
  ScrollBoxRenderable,
  TextareaRenderable,
} from "@opentui/core"
import { ManualClock } from "@opentui/core/testing"
import { testRender } from "@opentui/react/test-utils"
import { expect, test } from "bun:test"
import { act } from "react"

import type {
  IBuliApplication,
  IBuliApplicationSnapshot,
} from "@/app/contracts"
import { BuliRuntimeProvider } from "@/ui/context/application-context"
import { BuliUiControllerProvider } from "@/ui/context/ui-controller-context"
import {
  COMPLETION_NOTIFICATION_MIN_DURATION_MS,
  SessionCompletionNotifier,
} from "@/ui/shell/SessionCompletionNotifier"
import { SessionScreen } from "@/ui/shell/SessionScreen"
import { BuliUiController } from "@/ui/ui-controller"
import type { IAssistantMessage, IUserMessage } from "@/agent"
import { MeasuredTranscriptBox } from "@/ui/sessions/MeasuredTranscriptBox"
import type { ICompactionCheckpoint, ISessionSnapshot } from "@/sessions"
import { theme } from "@/ui/terminal/theme"

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

function sessionSnapshot(
  overrides: Partial<ISessionSnapshot> = {},
): ISessionSnapshot {
  return {
    messages: [],
    fileChangeProposals: [],
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
      promptPersisted: Promise.resolve(),
      runFinished: Promise.resolve(),
    }),
    steer: () => undefined,
    followUp: () => undefined,
    clearQueuedMessages: () => ({ steering: [], followUp: [] }),
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
    closeSession: async () => undefined,
    listSessions: () => [],
  }
  const controller = new BuliUiController({ application })
  controller.activateSession(SESSION_ID)

  return {
    application,
    controller,
    getSnapshot: () => snapshot,
    getSessionListenerCount: () => sessionListeners.size,
    setSnapshot(nextSnapshot: ISessionSnapshot): void {
      snapshot = nextSnapshot
      for (const listener of [...sessionListeners]) listener()
    },
  }
}

function sessionElement(
  harness: ReturnType<typeof createSessionHarness>,
) {
  return (
    <BuliRuntimeProvider runtime={harness.application}>
      <BuliUiControllerProvider controller={harness.controller}>
        <SessionScreen sessionId={SESSION_ID} />
      </BuliUiControllerProvider>
    </BuliRuntimeProvider>
  )
}

function notifierElement(
  harness: ReturnType<typeof createSessionHarness>,
  now: () => number,
) {
  return (
    <BuliRuntimeProvider runtime={harness.application}>
      <SessionCompletionNotifier sessionId={SESSION_ID} now={now} />
    </BuliRuntimeProvider>
  )
}

test.each(["screen", "notifier"] as const)(
  "%s retains its session source during closing and gets a fresh source on re-entry",
  async (consumer) => {
    const baseHarness = createSessionHarness(sessionSnapshot())
    baseHarness.controller.dispose()
    let source = baseHarness.application.openSession(SESSION_ID)
    let closing = false
    let openCount = 0
    const application: IBuliApplication = {
      ...baseHarness.application,
      openSession: () => {
        openCount += 1
        if (closing) throw new Error("Session is closing")
        return source
      },
    }
    const controller = new BuliUiController({ application })
    const harness = { ...baseHarness, application, controller }
    const element = () => consumer === "screen"
      ? sessionElement(harness)
      : notifierElement(harness, () => 0)

    try {
      await controller.activateSession(SESSION_ID)
      openCount = 0
      const setup = await testRender(element(), { width: 60, height: 18 })
      try {
        await act(async () => {
          await setup.renderOnce()
        })
        const initialOpenCount = openCount
        expect(initialOpenCount).toBeGreaterThan(0)

        closing = true
        await act(async () => {
          harness.setSnapshot(sessionSnapshot({
            messages: transcriptMessages(1),
          }))
          await setup.renderOnce()
        })
        expect(openCount).toBe(initialOpenCount)
      } finally {
        act(() => setup.renderer.destroy())
      }

      const freshSnapshot = sessionSnapshot({ messages: transcriptMessages(2) })
      let freshSnapshotReadCount = 0
      source = {
        subscribe: () => () => undefined,
        getSnapshot: () => {
          freshSnapshotReadCount += 1
          return freshSnapshot
        },
      }
      closing = false
      openCount = 0
      const reopenedSetup = await testRender(element(), { width: 60, height: 18 })
      try {
        await act(async () => {
          await reopenedSetup.renderOnce()
        })
        expect(openCount).toBeGreaterThan(0)
        expect(freshSnapshotReadCount).toBeGreaterThan(0)
      } finally {
        act(() => reopenedSetup.renderer.destroy())
      }
    } finally {
      controller.dispose()
    }
  },
)

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

test("renders and replaces the latest session checkpoint", async () => {
  const messages = transcriptMessages(2)
  const firstCheckpoint = checkpoint({
    id: "checkpoint-1",
    throughMessageId: messages[0]!.id,
    compactedMessageCount: 1,
    summary: "First checkpoint summary",
  })
  const harness = createSessionHarness(sessionSnapshot({
    messages,
    compactionCheckpoint: firstCheckpoint,
  }))
  const setup = await testRender(sessionElement(harness), {
    width: 70,
    height: 18,
  })

  try {
    await act(async () => {
      await setup.renderOnce()
    })
    expect(checkpointMarkdown(setup.renderer.root)?.content).toBe(
      firstCheckpoint.summary,
    )

    const latestCheckpoint = checkpoint({
      id: "checkpoint-2",
      throughMessageId: messages[1]!.id,
      compactedMessageCount: 2,
      summary: "Latest checkpoint summary",
    })
    await act(async () => {
      harness.setSnapshot(sessionSnapshot({
        messages,
        compactionCheckpoint: latestCheckpoint,
      }))
      await setup.renderOnce()
    })

    const markdown = markdownRenderables(setup.renderer.root)
    expect(markdown.some((renderable) => (
      renderable.content === firstCheckpoint.summary
    ))).toBe(false)
    expect(checkpointMarkdown(setup.renderer.root)?.content).toBe(
      latestCheckpoint.summary,
    )
  } finally {
    harness.controller.dispose()
    act(() => setup.renderer.destroy())
  }
})

test("navigates only modified transcript keys", async () => {
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

  } finally {
    harness.controller.dispose()
    act(() => setup.renderer.destroy())
  }
})

test("shows proposed changes in transcript order while keeping the prompt active", async () => {
  const messages = transcriptMessages(3)
  const harness = createSessionHarness(sessionSnapshot({
    messages,
    fileChangeProposals: [{
      id: "proposal-1",
      sessionId: SESSION_ID,
      runId: "run-history",
      toolCallId: "edit-1",
      operation: "edit",
      path: "src/example.ts",
      diff: [
        "--- a/src/example.ts",
        "+++ b/src/example.ts",
        "@@ -1,1 +1,1 @@",
        "-const value = 1",
        "+const value = 2",
        "",
      ].join("\n"),
      status: "applied",
      createdAt: 1,
      resolvedAt: 3,
    }],
  }))
  const setup = await testRender(sessionElement(harness), {
    width: 70,
    height: 18,
  })

  try {
    await act(async () => {
      await setup.renderOnce()
    })

    const frame = setup.captureCharFrame()
    expect(frame).not.toContain("Proposed changes")
    expect(frame).toContain("Transcript line 0")
    expect(findDiffRenderable(setup.renderer.root)).toBeDefined()
    expect(findScrollBoxRenderable(setup.renderer.root)).toBeDefined()

    const transcript = findScrollBoxRenderable(setup.renderer.root)
    const orderedText = transcript?.getChildren().flatMap((child) =>
      child.getChildren().map((item) => "plainText" in item
        ? String(item.plainText)
        : item.constructor.name)
    ).join("\n") ?? ""
    expect(orderedText.indexOf("Transcript line 0")).toBeLessThan(
      orderedText.indexOf("DiffRenderable"),
    )
    expect(orderedText.indexOf("DiffRenderable")).toBeLessThan(
      orderedText.indexOf("Transcript line 2"),
    )

    await act(async () => {
      await setup.mockInput.typeText("ok")
      await setup.renderOnce()
    })
    expect(textareaRenderable(setup.renderer.root).cursorOffset).toBe(2)
  } finally {
    harness.controller.dispose()
    act(() => setup.renderer.destroy())
  }
})

test("preserves Unicode diff text and colors when resizing and scrolling the session", async () => {
  const wideWidth = 80
  const narrowWidth = 36
  const terminalHeight = 32
  const changedLines = 100
  const unicodeText = "zażółć 🐍 日本語 abcdefghijklmnopqrstuvwxyz words wrapping on a narrow screen"
  const removedLine = `const value0 = "${unicodeText}";`
  const addedLine = `const value0 = "${unicodeText} changed";`
  const laterMessage = "Message after the Unicode diff"
  const harness = createSessionHarness(sessionSnapshot({
    messages: [{ ...transcriptMessages(1)[0]!, content: laterMessage, createdAt: 2 }],
    fileChangeProposals: [{
      id: "unicode-proposal",
      sessionId: SESSION_ID,
      runId: "run-history",
      toolCallId: "edit-unicode",
      operation: "edit",
      path: "example.ts",
      diff: [
        "--- a/example.ts",
        "+++ b/example.ts",
        `@@ -1,${changedLines} +1,${changedLines} @@`,
        ...Array.from({ length: changedLines }, (_, index) => [
          `-const value${index} = "${unicodeText}";`,
          `+const value${index} = "${unicodeText} changed";`,
        ]).flat(),
        "",
      ].join("\n"),
      status: "applied",
      createdAt: 1,
    }],
  }))
  const setup = await testRender(sessionElement(harness), {
    width: wideWidth,
    height: terminalHeight,
  })

  const render = async () => {
    await act(async () => {
      await setup.renderOnce()
      await Promise.all(codeRenderables(setup.renderer.root).map(
        (code) => code.highlightingDone,
      ))
      await setup.renderOnce()
    })
  }

  try {
    await render()
    const transcript = scrollBoxRenderable(setup.renderer.root)
    const diff = findDiffRenderable(transcript)
    if (!diff) throw new Error("Expected the Unicode file diff")
    expect(diff.filetype).toBe("typescript")
    act(() => transcript.scrollTo(0))
    await render()
    const wideFrame = setup.captureCharFrame()
    const wideSpans = setup.captureSpans()

    for (const width of [wideWidth, narrowWidth, wideWidth]) {
      act(() => setup.resize(width, terminalHeight))
      await render()
      act(() => transcript.scrollTo(0))
      await render()
      const frame = setup.captureCharFrame()
      const spans = setup.captureSpans()
      for (const [line, background] of [
        [removedLine, diff.removedBg],
        [addedLine, diff.addedBg],
      ] as const) {
        const coloredText = spans.lines.flatMap((row) => row.spans)
          .filter((span) => span.bg.equals(background))
          .map((span) => span.text).join("")
        expect(coloredText.replace(/\s/g, "")).toContain(line.replace(/\s/g, ""))
      }
      expect(codeRenderables(diff).some((code) => code.plainText.includes(removedLine))).toBe(true)
      if (width === wideWidth) {
        expect(frame).toBe(wideFrame)
        expect(spans).toEqual(wideSpans)
      }

      act(() => transcript.scrollTo(maximumScrollTop(transcript)))
      await render()
      expect(setup.captureCharFrame().replace(/\s/g, "")).toContain(laterMessage.replace(/\s/g, ""))
      act(() => transcript.scrollTo(0))
      await render()
      expect(setup.captureCharFrame()).toBe(frame)
      expect(setup.captureSpans()).toEqual(spans)
    }
  } finally {
    harness.controller.dispose()
    act(() => setup.renderer.destroy())
  }
})

test("remeasures hidden Unicode diff and code history without scrolling to it", async () => {
  const wideWidth = 100
  const narrowWidth = 36
  const terminalHeight = 30
  const historyLength = 40
  const changedLines = 100
  const maxSettlingFrames = 60
  const requiredQuietFrames = 3
  const unicodeText = "zażółć 🐍 日本語 abcdefghijklmnopqrstuvwxyz words wrapping on a narrow screen"
  const codeMessage: IAssistantMessage = {
    id: "offscreen-code",
    sessionId: SESSION_ID,
    runId: "run-history",
    createdAt: 1,
    role: "assistant",
    stopReason: "stop",
    content: [{
      type: "text",
      text: [
        "```typescript",
        ...Array.from({ length: changedLines }, (_, index) => `const line${index} = "${unicodeText}";`),
        "```",
      ].join("\n"),
    }],
  }
  const snapshot = sessionSnapshot({
    messages: [codeMessage, ...transcriptMessages(historyLength).map((message, index) => ({
      ...message,
      createdAt: index + 3,
    }))],
    fileChangeProposals: [{
      id: "offscreen-diff",
      sessionId: SESSION_ID,
      runId: "run-history",
      toolCallId: "offscreen-edit",
      operation: "edit",
      path: "example.ts",
      status: "applied",
      createdAt: 2,
      diff: [
        "--- a/example.ts",
        "+++ b/example.ts",
        `@@ -1,${changedLines} +1,${changedLines} @@`,
        ...Array.from({ length: changedLines }, (_, index) => [
          `-const value${index} = "${unicodeText}";`,
          `+const value${index} = "${unicodeText} changed";`,
        ]).flat(),
        "",
      ].join("\n"),
    }],
  })
  const harness = createSessionHarness(snapshot)
  const setup = await testRender(sessionElement(harness), {
    width: wideWidth,
    height: terminalHeight,
    clock: new ManualClock(),
  })
  const transcript = scrollBoxRenderable(setup.renderer.root)
  const capture = () => ({
    characters: setup.captureCharFrame(),
    spans: setup.captureSpans(),
    height: transcript.scrollHeight,
    top: transcript.scrollTop,
    maximumTop: maximumScrollTop(transcript),
    code: codeRenderables(transcript).map((code) => ({
      width: code.width,
      height: code.height,
      lines: code.virtualLineCount,
      text: code.plainText,
    })),
  })
  const settle = async () => {
    let previousSignature: string | undefined
    let quietFrames = 0
    for (let frame = 0; frame < maxSettlingFrames; frame += 1) {
      await act(async () => {
        await Promise.all(codeRenderables(transcript).map((code) => code.highlightingDone))
        const previousFrame = setup.renderer.frameId
        await setup.renderOnce()
        expect(setup.renderer.frameId).toBe(previousFrame + 1)
      })
      const signature = JSON.stringify(capture())
      quietFrames = signature === previousSignature ? quietFrames + 1 : 0
      if (quietFrames >= requiredQuietFrames) return
      previousSignature = signature
    }
    throw new Error("Session transcript did not settle within the bounded frame limit")
  }

  try {
    await settle()
    const commonBox = transcript.getChildren()[0]
    expect(commonBox).toBeInstanceOf(MeasuredTranscriptBox)
    expect(commonBox?.getChildren()).toHaveLength(historyLength + 2)
    const codes = codeRenderables(transcript)
    const diff = findDiffRenderable(transcript)
    if (!diff) throw new Error("Expected offscreen Unicode diff")
    expect(diff.filetype).toBe("typescript")
    expect(diff.screenY + diff.height).toBeLessThanOrEqual(transcript.viewport.screenY)
    const initial = capture()
    expect(initial.top).toBe(initial.maximumTop)

    for (const width of [narrowWidth, wideWidth]) {
      act(() => setup.resize(width, terminalHeight))
      await settle()
      expect(diff.screenY + diff.height).toBeLessThanOrEqual(transcript.viewport.screenY)
      const currentCodes = codeRenderables(transcript)
      expect(currentCodes).toHaveLength(codes.length)
      codes.forEach((code, index) => expect(currentCodes[index]).toBe(code))
      const hidden = capture()
      expect(hidden.top).toBe(hidden.maximumTop)
      if (width === narrowWidth) expect(hidden.height).toBeGreaterThan(initial.height)
      else expect(hidden).toEqual(initial)

      act(() => transcript.scrollTo(0))
      await settle()
      expect(capture().height).toBe(hidden.height)
      expect(capture().code).toEqual(hidden.code)
      act(() => transcript.scrollTo(maximumScrollTop(transcript)))
      await settle()
      expect(capture()).toEqual(hidden)
    }

    await act(async () => harness.setSnapshot({
      ...snapshot,
      messages: [{
        ...codeMessage,
        content: [...codeMessage.content, { type: "reasoning", text: unicodeText.repeat(historyLength) }],
      }, ...snapshot.messages.slice(1)],
    }))
    await settle()
    const grown = capture()
    expect(grown.height).toBeGreaterThan(initial.height)
    act(() => transcript.scrollTo(0))
    await settle()
    expect(capture().height).toBe(grown.height)
    act(() => transcript.scrollTo(maximumScrollTop(transcript)))
    await settle()
    await act(async () => harness.setSnapshot(snapshot))
    await settle()
    expect(capture()).toEqual(initial)
  } finally {
    act(() => setup.renderer.destroy())
    harness.controller.dispose()
    expect(harness.getSessionListenerCount()).toBe(0)
    expect(setup.renderer.getLifecyclePasses().size).toBe(0)
  }
})

test("notifies only for long runs completed while the terminal is blurred", async () => {
  let currentTime = 0
  const harness = createSessionHarness(sessionSnapshot({
    isRunning: true,
    activeRunId: "initial-run",
  }))
  const setup = await testRender(
    notifierElement(harness, () => currentTime),
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

function checkpoint(
  overrides: Partial<ICompactionCheckpoint>,
): ICompactionCheckpoint {
  return {
    id: "checkpoint",
    sessionId: SESSION_ID,
    createdAt: 1,
    reason: "automatic",
    compactedMessageCount: 1,
    throughMessageId: "message-0",
    summary: "Checkpoint summary",
    ...overrides,
  }
}

function checkpointMarkdown(root: Renderable): MarkdownRenderable | undefined {
  return markdownRenderables(root).find((renderable) => (
    renderable.content.includes("checkpoint summary")
  ))
}

function markdownRenderables(root: Renderable): MarkdownRenderable[] {
  return root.getChildren().flatMap((child) => [
    ...(child instanceof MarkdownRenderable ? [child] : []),
    ...markdownRenderables(child),
  ])
}

function codeRenderables(root: Renderable): CodeRenderable[] {
  return root.getChildren().flatMap((child) => [
    ...(child instanceof CodeRenderable ? [child] : []),
    ...codeRenderables(child),
  ])
}

function findDiffRenderable(
  root: Renderable,
): DiffRenderable | undefined {
  if (root instanceof DiffRenderable) return root
  for (const child of root.getChildren()) {
    const diff = findDiffRenderable(child)
    if (diff) return diff
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
