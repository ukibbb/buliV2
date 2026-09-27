import {
  BoxRenderable,
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
  TextRenderable,
} from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { expect, spyOn, test } from "bun:test"
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
import type { IAssistantMessage, IUserInputContent, IUserMessage } from "@/agent"
import * as ChatView from "@/ui/chat/Chat"
import * as ScreenView from "@/ui/shell/SessionScreen"
import * as MenuView from "@/ui/chat/InputMenu"
import * as QueueView from "@/ui/chat/QueuedMessages"
import * as EditorView from "@/ui/chat/PromptEditor"
import * as StatusView from "@/ui/chat/ChatStatus"
import * as TranscriptView from "@/ui/sessions/Transcript"
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
    activeBranchId: "main",
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
    searchPaths: async () => Array.from({ length: 12 }, (_, index) => ({
      kind: "file" as const,
      path: `/workspace/src/file-${index}.ts`,
      displayPath: `src/file-${index}.ts`,
    })),
    createBranch: () => "side",
    returnToParentBranch: () => undefined,
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

test("resource-only draft changes update the editor without rendering its siblings", async () => {
  const harness = createSessionHarness(sessionSnapshot())
  const editorRenders = spyOn(EditorView, "PromptEditor")
  const menuRenders = spyOn(MenuView, "InputMenu")
  const queueRenders = spyOn(QueueView, "QueuedMessages")
  const statusRenders = spyOn(StatusView, "ChatStatus")
  const setup = await testRender(sessionElement(harness), { width: 80, height: 24 })
  const imageDraft = (data: string): IUserInputContent => ({
    text: "[Image 1]",
    attachments: [{
      type: "image", mimeType: "image/png", data, filename: "clipboard-1.png",
      source: { value: "[Image 1]", start: 0, end: 9 },
    }],
  })
  const update = async (data: string) => {
    act(() => harness.controller.updateDraft(imageDraft(data)))
    await act(async () => { await setup.renderOnce() })
  }
  const siblingCounts = () => [menuRenders.mock.calls.length, queueRenders.mock.calls.length, statusRenders.mock.calls.length]
  try {
    await update("first-image")
    const editor = textareaRenderable(setup.renderer.root)
    const initialSiblingCounts = siblingCounts()
    const initialEditorCount = editorRenders.mock.calls.length
    await update("replacement-image")
    expect(editorRenders.mock.calls.length).toBeGreaterThan(initialEditorCount)
    expect(editorRenders.mock.calls.at(-1)?.[0].value.attachments?.[0]?.data).toBe("replacement-image")
    expect(siblingCounts()).toEqual(initialSiblingCounts)
    expect(textareaRenderable(setup.renderer.root)).toBe(editor)
    expect(editor.plainText).toBe("[Image 1]")
    expect(editor.focused).toBe(true)
  } finally {
    harness.controller.dispose()
    act(() => setup.renderer.destroy())
    for (const spy of [editorRenders, menuRenders, queueRenders, statusRenders]) spy.mockRestore()
  }
})

test("Home chat uses idle selectors without opening a session", async () => {
  const harness = createSessionHarness(sessionSnapshot())
  const openSession = spyOn(harness.application, "openSession")
  const setup = await testRender(
    <BuliRuntimeProvider runtime={harness.application}>
      <BuliUiControllerProvider controller={harness.controller}>
        <ChatView.Chat />
      </BuliUiControllerProvider>
    </BuliRuntimeProvider>,
    { width: 80, height: 24 },
  )
  try {
    await act(async () => { await setup.renderOnce() })
    expect(openSession).not.toHaveBeenCalled()
    expect(textareaRenderable(setup.renderer.root).focused).toBe(true)
  } finally {
    harness.controller.dispose()
    act(() => setup.renderer.destroy())
    openSession.mockRestore()
  }
})

test.each(["commands", "paths"] as const)("isolates streaming, %s menu, queues and status in every settled frame", async (mode) => {
  const streamingMessage: IAssistantMessage = {
    id: "streaming", sessionId: SESSION_ID, runId: "run-stream", role: "assistant",
    createdAt: 1, stopReason: "pending", content: [{ type: "text", text: "Starting answer" }],
  }
  const harness = createSessionHarness(sessionSnapshot({
    messages: transcriptMessages(20), isRunning: true, streamingMessage,
  }))
  const screenRenders = spyOn(ScreenView, "SessionScreen")
  const chatRenders = spyOn(ChatView, "Chat")
  const menuRenders = spyOn(MenuView, "InputMenu")
  const queueRenders = spyOn(QueueView, "QueuedMessages")
  const editorRenders = spyOn(EditorView, "PromptEditor")
  const statusRenders = spyOn(StatusView, "ChatStatus")
  const transcriptRenders = spyOn(TranscriptView, "Transcript")
  const setup = await testRender(sessionElement(harness), { width: 80, height: 28 })
  const render = async () => { await act(async () => { await setup.renderOnce() }) }
  const counts = () => [
    menuRenders.mock.calls.length, queueRenders.mock.calls.length,
    editorRenders.mock.calls.length, statusRenders.mock.calls.length,
  ] as const
  try {
    await render()
    // Add steering while a run is already streaming, as in the reported case.
    act(() => harness.setSnapshot({
      ...harness.getSnapshot(),
      pendingSteeringMessages: [{
        ...transcriptMessages(1)[0]!, id: "queued-steering", source: "steer",
        content: "Please keep the editor stable. ".repeat(5),
      }],
    }))
    await act(async () => {
      if (mode === "commands") harness.controller.updateInput("/")
      else await setup.mockInput.typeText("@src")
    })
    if (mode === "paths") await act(async () => { await Bun.sleep(35) })
    for (let frame = 0; frame < 6; frame++) await render()
    const editor = textareaRenderable(setup.renderer.root)
    const queue = setup.renderer.root.findDescendantById("queued-messages")!
    const menu = setup.renderer.root.findDescendantById("command-menu")!
    const transcript = scrollBoxRenderable(setup.renderer.root)
    expect(queue).toBeDefined()
    expect(menu).toBeDefined()
    expect(harness.controller.getSnapshot().menu?.items.length).toBeGreaterThan(1)
    expect(setup.captureCharFrame()).toContain("Steering")
    act(() => editor.setSelection(0, editor.plainText.length))
    await render()
    const selection = editor.getSelectedText()
    expect(selection.length).toBeGreaterThan(0)
    const initialTranscriptRenders = transcriptRenders.mock.calls.length
    const geometry = () => [transcript, queue, menu, editor].map((node) => [node.y, node.height])
    const pixels = () => setup.captureSpans().lines.slice(queue.y, menu.y + menu.height)
    const stableGeometry = geometry()
    const stablePixels = pixels()
    const initialCounts = counts()
    const initialScreenRenders = screenRenders.mock.calls.length
    const initialChatRenders = chatRenders.mock.calls.length
    expect(initialScreenRenders).toBeGreaterThan(0)
    expect(initialChatRenders).toBeGreaterThan(0)
    expect(initialCounts.every((count) => count > 0)).toBe(true)
    const draft = editor.plainText
    let text = "# Answer\n\n```typescript\n"
    for (let chunk = 0; chunk < 20; chunk++) {
      text += `const value${chunk} = "${"streaming text ".repeat(6)}"\n`
      act(() => harness.setSnapshot({
        ...harness.getSnapshot(),
        streamingMessage: { ...streamingMessage, content: [{ type: "text", text }] },
      }))
      // Check every frame, not just a capture after several stabilizing renders.
      for (let frame = 0; frame < 2; frame++) {
        await render()
        expect(geometry()).toEqual(stableGeometry)
        expect(pixels()).toEqual(stablePixels)
        expect(textareaRenderable(setup.renderer.root)).toBe(editor)
        expect(editor.focused).toBe(true)
        expect(editor.plainText).toBe(draft)
        expect(editor.getSelectedText()).toBe(selection)
        expect(counts()).toEqual(initialCounts)
      }
    }
    expect(transcriptRenders.mock.calls.length).toBeGreaterThan(initialTranscriptRenders)
    const streamingMarkdown = markdownRenderables(setup.renderer.root).find((node) => node.content === text)
    expect(streamingMarkdown).toBeDefined()
    const transcriptCount = transcriptRenders.mock.calls.length
    act(() => harness.controller.moveMenuSelection(1))
    await render()
    expect(harness.controller.getSnapshot().menu?.selectedIndex).toBe(1)
    expect(transcriptRenders.mock.calls.length).toBe(transcriptCount)
    expect(queueRenders.mock.calls.length).toBe(initialCounts[1])
    expect(editorRenders.mock.calls.length).toBe(initialCounts[2])
    expect(statusRenders.mock.calls.length).toBe(initialCounts[3])
    const menuCount = menuRenders.mock.calls.length
    act(() => harness.setSnapshot({
      ...harness.getSnapshot(), contextUsage: {
        estimatedInputTokens: 1_234, compactionInputTokens: 2_468, shouldCompact: false,
      },
    }))
    await render()
    expect(setup.captureCharFrame()).toContain("ctx ~1.2k")
    expect(transcriptRenders.mock.calls.length).toBe(transcriptCount)
    expect(menuRenders.mock.calls.length).toBe(menuCount)
    expect(queueRenders.mock.calls.length).toBe(initialCounts[1])
    expect(editorRenders.mock.calls.length).toBe(initialCounts[2])
    act(() => harness.setSnapshot({
      ...harness.getSnapshot(), pendingSteeringMessages: [{
        ...harness.getSnapshot().pendingSteeringMessages[0]!,
        content: "Changed queue content with the same message ID",
      }],
    }))
    for (let frame = 0; frame < 4; frame++) await render()
    expect(setup.captureCharFrame()).toContain("Changed queue content with the same message ID")
    expect(transcriptRenders.mock.calls.length).toBe(transcriptCount)
    expect(editorRenders.mock.calls.length).toBe(initialCounts[2])
    act(() => harness.setSnapshot({ ...harness.getSnapshot(), pendingSteeringMessages: [] }))
    for (let frame = 0; frame < 4; frame++) await render()
    expect(setup.renderer.root.findDescendantById("queued-messages")).toBeUndefined()
    expect(transcriptRenders.mock.calls.length).toBe(transcriptCount)
    expect(editor.focused).toBe(true)
    expect(screenRenders.mock.calls.length).toBe(initialScreenRenders)
    expect(chatRenders.mock.calls.length).toBe(initialChatRenders)
  } finally {
    harness.controller.dispose()
    act(() => setup.renderer.destroy())
    for (const spy of [screenRenders, chatRenders, menuRenders, queueRenders, editorRenders, statusRenders, transcriptRenders]) spy.mockRestore()
  }
})

test("branch indicator and transcript follow session snapshots", async () => {
  const harness = createSessionHarness(sessionSnapshot({ activeBranchId: "side-a", messages: transcriptMessages(1) }))
  const setup = await testRender(sessionElement(harness), { width: 100, height: 20 })
  try {
    await act(async () => { await setup.renderOnce() })
    expect(setup.captureCharFrame()).toContain("Side branch side-a")
    expect(setup.captureCharFrame()).toContain("read-only")
    expect(setup.captureCharFrame()).toContain("Transcript line 0")
    await act(async () => {
      harness.setSnapshot(sessionSnapshot({ activeBranchId: "side-parent", messages: transcriptMessages(2) }))
      await setup.renderOnce()
    })
    expect(setup.captureCharFrame()).toContain("Side branch side-parent")
    await act(async () => {
      harness.setSnapshot(sessionSnapshot())
      await setup.renderOnce()
    })
    expect(setup.captureCharFrame()).not.toContain("Side branch")
    expect(setup.captureCharFrame()).not.toContain("Transcript line 0")
  } finally {
    harness.controller.dispose()
    act(() => setup.renderer.destroy())
  }
})

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

test("scrolls and resizes full-width user cards without repainting the header or editor", async () => {
  const messages = transcriptMessages(3).map((message, index) => ({
    ...message,
    content: [
      `  # Prompt ${index} **literal**  `,
      `zażółć 🐍 日本語 ${"wrapped text ".repeat(12)}`,
      ...Array.from({ length: 12 }, (_, row) => `  prompt-${index}-row-${row}  `),
      "",
    ].join("\n"),
  }))
  const harness = createSessionHarness(sessionSnapshot({ messages }))
  const setup = await testRender(<box width="100%" height="100%" flexDirection="column">
    <text height={1} flexShrink={0}>Fixed workspace header</text>
    {sessionElement(harness)}
  </box>, { width: 80, height: 24 })
  const render = async () => {
    await act(async () => { await setup.renderOnce() })
  }

  try {
    await act(async () => {
      await setup.mockInput.typeText("draft remains editable")
      await setup.renderOnce()
    })
    const transcript = scrollBoxRenderable(setup.renderer.root)
    const editor = textareaRenderable(setup.renderer.root)
    act(() => editor.setSelection(0, 5))
    await render()
    const cards = messages.map((message) => setup.renderer.root.findDescendantById(
      `user-message-${message.id}`,
    ) as BoxRenderable)

    for (const [width, height] of [[80, 24], [40, 14], [40, 10], [120, 30], [80, 24]] as const) {
      act(() => setup.resize(width, height))
      await render()
      act(() => transcript.scrollTo(0))
      await render()
      const startFrame = setup.captureCharFrame()
      const startLines = startFrame.split("\n")
      const startSpans = setup.captureSpans()
      const viewportBottom = transcript.viewport.y + transcript.viewport.height
      const activity = setup.renderer.root.findDescendantById("chat-activity")!
      const status = setup.renderer.root.findDescendantById("chat-status")!
      expect(transcript.viewport.y).toBe(1)
      expect(transcript.viewport.width).toBe(width - 1)
      expect(transcript.viewport.height).toBeGreaterThan(0)
      expect(viewportBottom).toBeLessThanOrEqual(activity.y)
      expect(viewportBottom).toBeLessThanOrEqual(editor.y)
      expect(editor.y + editor.height).toBeLessThanOrEqual(status.y)
      expect(status.y + status.height).toBeLessThanOrEqual(height)
      expect(startLines[0]!.trim()).toBe("Fixed workspace header")
      for (const [index, card] of cards.entries()) {
        expect(setup.renderer.root.findDescendantById(card.id)).toBe(card)
        expect(card.width).toBe(transcript.viewport.width)
        expect(card.x).toBe(transcript.viewport.x)
        expect(card.title).toBeUndefined()
        expect((card.getChildren()[0] as TextRenderable).plainText).toBe(messages[index]!.content)
      }

      const visibleRows: string[] = []
      const maximum = maximumScrollTop(transcript)
      expect(maximum).toBeGreaterThan(0)
      for (let row = 0; row <= maximum; row++) {
        act(() => transcript.scrollTo(row))
        await render()
        const lines = setup.captureCharFrame().split("\n")
        expect(lines.slice(0, transcript.viewport.y)).toEqual(startLines.slice(0, transcript.viewport.y))
        expect(lines.slice(viewportBottom)).toEqual(startLines.slice(viewportBottom))
        expect(setup.captureSpans().lines.slice(viewportBottom))
          .toEqual(startSpans.lines.slice(viewportBottom))
        visibleRows.push(...lines.slice(transcript.viewport.y, viewportBottom))
      }
      const allVisible = visibleRows.join("\n")
      for (let index = 0; index < messages.length; index++) {
        expect(allVisible).toContain(`# Prompt ${index} **literal**`)
        for (let row = 0; row < 12; row++) expect(allVisible).toContain(`prompt-${index}-row-${row}`)
      }
      expect(allVisible).toContain("zażółć 🐍 日本語")
      expect(textareaRenderable(setup.renderer.root)).toBe(editor)
      expect(editor.focused).toBe(true)
      expect(editor.plainText).toBe("draft remains editable")
      expect(editor.getSelectedText()).toBe("draft")
      act(() => transcript.scrollTo(0))
      await render()
      expect(setup.captureCharFrame()).toBe(startFrame)
      expect(setup.captureSpans()).toEqual(startSpans)
    }
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

test("streams compaction snapshots in place, follows the bottom and respects scrolling away", async () => {
  const messages = transcriptMessages(40)
  const previous = checkpoint({ summary: "Previous checkpoint summary" })
  const progress = {
    id: "candidate",
    throughMessageId: messages[38]!.id,
    summary: "# Streaming checkpoint summary\n\nFirst fragment",
  }
  const harness = createSessionHarness(sessionSnapshot({
    messages, compactionCheckpoint: previous, compactionProgress: progress, isCompacting: true,
  }))
  const setup = await testRender(sessionElement(harness), { width: 80, height: 22 })
  try {
    await act(async () => { await setup.renderOnce() })
    const transcript = scrollBoxRenderable(setup.renderer.root)
    const preview = checkpointMarkdown(setup.renderer.root)
    expect(preview?.streaming).toBe(true)
    expect(preview?.content).toBe(progress.summary)
    expect(setup.captureCharFrame()).toContain("First fragment")
    expect(setup.captureCharFrame()).toContain("Compacting context")
    expect(setup.captureCharFrame()).not.toContain(previous.summary)
    const initialMaximum = maximumScrollTop(transcript)
    expect(transcript.scrollTop).toBe(initialMaximum)
    const expanded = {
      ...progress,
      summary: progress.summary + Array.from({ length: 20 }, (_, i) => `\n\nProgress line ${i}`).join(""),
    }
    await act(async () => {
      harness.setSnapshot(sessionSnapshot({
        messages, compactionCheckpoint: previous, compactionProgress: expanded, isCompacting: true,
      }))
      await setup.renderOnce()
    })
    expect(checkpointMarkdown(setup.renderer.root)).toBe(preview)
    expect(maximumScrollTop(transcript)).toBeGreaterThan(initialMaximum)
    expect(transcript.scrollTop).toBe(maximumScrollTop(transcript))
    expect(setup.captureCharFrame()).toContain("Progress line 19")
    await act(async () => {
      await setup.mockMouse.scroll(transcript.x + 1, transcript.y + 1, "up")
      await setup.renderOnce()
    })
    const scrolledAway = transcript.scrollTop
    expect(scrolledAway).toBeLessThan(maximumScrollTop(transcript))
    const final = { ...expanded, summary: expanded.summary + "\n\nFinal fragment" }
    await act(async () => {
      harness.setSnapshot(sessionSnapshot({
        messages, compactionCheckpoint: previous, compactionProgress: final, isCompacting: true,
      }))
      await setup.renderOnce()
    })
    expect(transcript.scrollTop).toBe(scrolledAway)
    expect(checkpointMarkdown(setup.renderer.root)).toBe(preview)
    await act(async () => {
      harness.setSnapshot(sessionSnapshot({
        messages, compactionCheckpoint: checkpoint({ ...final, compactedMessageCount: 39 }),
      }))
      await setup.renderOnce()
    })
    expect(checkpointMarkdown(setup.renderer.root)).toBe(preview)
    expect(preview?.streaming).toBe(false)
    expect(preview?.content).toBe(final.summary)
    expect(markdownRenderables(setup.renderer.root)).toHaveLength(1)
    expect(transcript.scrollTop).toBe(scrolledAway)
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

    const transcript = scrollBoxRenderable(setup.renderer.root)
    const diff = findDiffRenderable(transcript)!
    const cards = messages.map((message) => transcript.findDescendantById(`user-message-${message.id}`)!)
    expect(diff).toBeDefined()
    for (const [index, card] of cards.entries()) {
      expect(card).toBeInstanceOf(BoxRenderable)
      expect((card.getChildren()[0] as TextRenderable).plainText).toBe(messages[index]!.content)
    }
    expect(cards[0]!.y + cards[0]!.height).toBeLessThanOrEqual(cards[1]!.y)
    expect(cards[1]!.y + cards[1]!.height).toBeLessThanOrEqual(diff.y)
    expect(diff.y + diff.height).toBeLessThanOrEqual(cards[2]!.y)
    expect(setup.captureCharFrame()).not.toContain("Proposed changes")
    expect(setup.captureCharFrame()).toContain("Transcript line 2")
    act(() => transcript.scrollTo(0))
    await act(async () => { await setup.renderOnce() })
    expect(setup.captureCharFrame()).toContain("Transcript line 0")

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
