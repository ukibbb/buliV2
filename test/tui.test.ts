import { expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  BoxRenderable,
  CodeRenderable,
  RGBA,
  TextRenderable,
  parseKeypress,
  type Renderable,
  ScrollBoxRenderable,
  TextareaRenderable,
} from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { act, createElement } from "react"

import { createBuliApplication } from "@/app"
import type {
  IBuliApplication,
  IBuliApplicationSnapshot,
  IBuliPromptInput,
  IBuliPromptRun,
} from "@/app/contracts"
import type { IAuthenticationService } from "@/authentication/contracts"
import { BuliApplicationRuntime } from "@/app/runtime"
import { BuliRuntimeProvider } from "@/ui/context/application-context"
import type {
  IAgentModel,
} from "@/agent"
import { createSessionTestSource, type ISessionTestData } from "./fixtures/session-source"
import { SQLiteSessionManager } from "@/sessions/sqlite/sqlite-session-manager"
import { BuliTui } from "@/ui/shell/BuliTui"
import { COMPLETION_NOTIFICATION_MIN_DURATION_MS } from "@/ui/shell/SessionCompletionNotifier"
import { BuliUiController } from "@/ui/ui-controller"
import {
  BuliUiControllerProvider,
  useBuliNavigationSnapshot,
  useBuliUiSnapshot,
} from "@/ui/context/ui-controller-context"
import { glyphs, theme } from "@/ui/terminal/theme"

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
  readonly workspaceRoot?: string
  readonly searchPaths?: IBuliApplication["searchPaths"]
  readonly applicationSnapshot?: IBuliApplicationSnapshot
  readonly sessionSnapshot?: ISessionTestData
  readonly submitPrompt?: (prompt: IBuliPromptInput) => IBuliPromptRun
  readonly steer?: (sessionId: string, text: string) => void
  readonly followUp?: (sessionId: string, text: string) => void
  readonly clearQueuedMessages?: IBuliApplication["clearQueuedMessages"]
  readonly refreshModels?: IBuliApplication["refreshModels"]
}

function fakeApplication(options: IFakeApplicationOptions = {}) {
  const prompts: IBuliPromptInput[] = []
  const steering: Array<{ sessionId: string; text: string }> = []
  const followUps: Array<{ sessionId: string; text: string }> = []
  const aborted: string[] = []
  const sessionSnapshot: ISessionTestData = options.sessionSnapshot ?? {
    activeBranchId: "main",
    messages: [],
    pendingSteeringMessages: [],
    pendingFollowUpMessages: [],
    isRunning: false,
    isCompacting: false,
    pendingToolCallIds: [],
  }
  let runCount = 0
  const fixture = createSessionTestSource(sessionSnapshot)
  const session = fixture.source
  const application: IBuliApplication = {
    workspaceRoot: options.workspaceRoot ?? WORKSPACE_ROOT,
    ...(options.searchPaths ? { searchPaths: options.searchPaths } : {}),
    subscribe: () => () => undefined,
    getSnapshot: () => options.applicationSnapshot ?? APPLICATION_SNAPSHOT,
    refreshModels: async (signal) => options.refreshModels?.(signal),
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
    closeSession: async () => undefined,
    listSessions: () => [],
    submitPrompt: (prompt) => {
      prompts.push(prompt)
      return options.submitPrompt?.(prompt) ?? {
        sessionId: prompt.sessionId ?? "default",
        runId: `run-${++runCount}`,
        promptPersisted: Promise.resolve(),
        runFinished: Promise.resolve(),
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
    activateNovibe: async () => "NoVibe włączone.",
    deactivateNovibe: async () => "NoVibe wyłączone.",
    createBranch: () => "side",
    returnToParentBranch: () => undefined,
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
    aborted,
    getSessionData: fixture.getData,
    setSessionSnapshot(snapshot: ISessionTestData) {
      fixture.setData(snapshot)
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
  options: {
    readonly authentication?: IAuthenticationService
    readonly now?: () => number
  } = {},
) {
  return createElement(BuliRuntimeProvider, {
    runtime,
    children: createElement(BuliUiControllerProvider, {
      controller,
      children: createElement(BuliTui, {
        authentication: options.authentication ?? AUTHENTICATION,
        openUrl: () => {},
        ...(options.now ? { now: options.now } : {}),
      }),
    }),
  })
}

test.each([WORKSPACE_ROOT, `${WORKSPACE_ROOT}/${"long-directory/".repeat(12)}`])(
  "keeps workspace %s in a single fixed header outside authentication",
  async (workspaceRoot) => {
    const fake = fakeApplication({ workspaceRoot })
    const controller = new BuliUiController({ application: fake.application })
    const initialSession = fake.application.openSession("default").getSnapshot()
    fake.setSessionSnapshot({
      ...initialSession,
      messages: Array.from({ length: 40 }, (_, index) => ({
        id: `message-${index}`,
        sessionId: "default",
        runId: "history",
        role: "user" as const,
        source: "prompt" as const,
        content: `Transcript line ${index}`,
        createdAt: index,
      })),
    })
    const setup = await testRender(buliElementWithController(fake.application, controller), {
      width: 40, height: 14,
    })
    const render = async () => {
      await act(async () => { await setup.renderOnce() })
      await act(async () => { await setup.renderOnce() })
    }
    const checkHeader = () => {
      const header = setup.renderer.root.findDescendantById("workspace-header")!
      expect(header.y).toBe(0)
      expect(header.height).toBe(1)
      expect(header.width).toBe(40)
      expect((header as TextRenderable).fg.equals(RGBA.fromHex(theme.pink))).toBe(true)
      const frame = setup.captureCharFrame()
      expect(frame.split("\n")[0]!.startsWith(WORKSPACE_ROOT)).toBe(true)
      expect(frame.match(/\/workspace/g)).toHaveLength(1)
      return header
    }

    try {
      await render()
      const header = checkHeader()
      await act(async () => { await controller.activateSession("default") })
      await render()
      expect(checkHeader()).toBe(header)
      const transcript = setup.renderer.root.findDescendantById("session-transcript")
      expect(transcript).toBeInstanceOf(ScrollBoxRenderable)
      const scroll = transcript as ScrollBoxRenderable
      expect(scroll.y).toBeGreaterThanOrEqual(1)
      expect(scroll.scrollTop).toBeGreaterThan(0)
      act(() => scroll.scrollTo(0))
      await render()
      expect(scroll.scrollTop).toBe(0)
      expect(setup.captureCharFrame()).toContain("Transcript line 0")
      expect(checkHeader()).toBe(header)

      act(() => controller.openAuthentication("login"))
      await render()
      expect(setup.renderer.root.findDescendantById("workspace-header")).toBeUndefined()
      expect(setup.captureCharFrame()).not.toContain(WORKSPACE_ROOT)
      act(() => controller.closeAuthentication())
      await render()
      checkHeader()
      expect(textareaRenderable(setup.renderer.root).focused).toBe(true)
    } finally {
      act(() => setup.renderer.destroy())
      controller.dispose()
    }
  },
)

test.each([[40, 8], [40, 10], [40, 12], [40, 13], [40, 14], [80, 14], [80, 24], [120, 30]])("keeps shortcuts beside one snake above the editor, with model status below at %i × %i", async (width, height) => {
  const fake = fakeApplication()
  const controller = new BuliUiController({ application: fake.application })
  await controller.activateSession("default")
  const idle = fake.getSessionData()
  const setup = await testRender(buliElementWithController(fake.application, controller), {
    width, height,
  })
  try {
    await act(async () => { await setup.renderOnce() })
    const textarea = textareaRenderable(setup.renderer.root)
    for (const state of [
      { isRunning: false, isCompacting: false },
      { isRunning: true, isCompacting: false },
      { isRunning: false, isCompacting: true },
      { isRunning: true, isCompacting: true },
      { isRunning: false, isCompacting: false },
    ]) {
      act(() => fake.setSessionSnapshot({ ...idle, ...state }))
      await act(async () => { await setup.renderOnce() })
      await act(async () => { await setup.renderOnce() })
      const activity = setup.renderer.root.findDescendantById("chat-activity")
      const snake = setup.renderer.root.findDescendantById("chat-activity-snake")
      const status = setup.renderer.root.findDescendantById("chat-status")!
      const active = state.isRunning || state.isCompacting
      expect(Boolean(activity)).toBe(active)
      expect(Boolean(snake)).toBe(active)
      expect(textarea.parent!.y + textarea.parent!.height).toBeLessThanOrEqual(status.y)
      expect(status.y + status.height).toBeLessThanOrEqual(height)
      if (activity) {
        if (height <= 12) expect(activity.height).toBe(1)
        else expect(activity.height).toBeGreaterThanOrEqual(1)
        expect(activity.y).toBeGreaterThanOrEqual(0)
        expect(activity.y).toBe(snake!.y)
        expect(snake!.x + snake!.width).toBeLessThanOrEqual(activity.x)
        expect(activity.y + activity.height).toBeLessThanOrEqual(textarea.parent!.y)
        expect(snake!.y + snake!.height).toBeLessThanOrEqual(textarea.parent!.y)
        const children = activity.getChildren()
        expect(children).toHaveLength(1)
        expect(children[0]).toBeInstanceOf(TextRenderable)
        expect(snake).toBeInstanceOf(BoxRenderable)
        expect(snake!.parent).toBe(activity.parent)
        expect(snake!.height).toBe(activity.height)
        expect(snake!.getChildren()[0]!.height).toBe(1)
        expect(setup.captureCharFrame().split("\n")[snake!.y]).toContain(glyphs.snakeHead)
      }
      expect(textarea.y + textarea.height).toBeLessThan(height)
      expect(textareaRenderable(setup.renderer.root)).toBe(textarea)
      expect(textarea.focused).toBe(true)
      expect((textarea.parent as BoxRenderable).borderColor.equals(RGBA.fromHex(theme.pink))).toBe(true)
      const frame = setup.captureCharFrame()
      expect(frame).toContain("[ Test : medium ]")
      expect(frame).not.toContain("During generation")
      expect(frame.split(glyphs.snakeHead).length - 1).toBe(active ? 1 : 0)
      const activityText = frame.split("\n")
        .slice(activity?.y ?? 0, activity ? activity.y + activity.height : 0)
        .map((line) => line.slice(activity?.x ?? 0, activity ? activity.x + activity.width : 0))
        .join(" ").replace(/[│\s]+/g, " ")
      if (active && height <= 12) {
        expect(activityText.trim()).toStartWith("[ Esc ] stop")
        expect(activityText).not.toMatch(/[┌┐└┘]/)
        expect(activityText).not.toContain("[ Enter ]")
      } else if (state.isCompacting) {
        expect(activityText).toContain("Compacting context")
        expect(activityText).toContain("[ Esc ] stop")
        expect(frame).not.toContain("[ Enter ] steer")
      } else if (state.isRunning) {
        expect(activityText).toContain("[ Enter ] steer [ Alt + Enter ] follow-up [ Esc ] stop")
        expect(frame).not.toContain("Compacting context")
      } else {
        expect(activity).toBeUndefined()
        expect(activityText).toBe("")
      }
    }
  } finally {
    act(() => setup.renderer.destroy())
    controller.dispose()
  }
})

test("keeps asynchronous path suggestions above the editor and completes the selected reference", async () => {
  const queries: string[] = []
  let releaseSearch!: () => void
  const gate = new Promise<void>((resolve) => { releaseSearch = resolve })
  const fake = fakeApplication({
    searchPaths: async (query) => {
      queries.push(query)
      await gate
      return Array.from({ length: 30 }, (_, index) => ({
        kind: "file" as const,
        path: `/workspace/src/file-${index}.ts`,
        displayPath: `src/file-${index}.ts`,
      }))
    },
  })
  const controller = new BuliUiController({ application: fake.application })
  const setup = await testRender(buliElementWithController(fake.application, controller), {
    width: 40, height: 14,
  })
  const render = async () => {
    for (let frame = 0; frame < 3; frame++) {
      await act(async () => { await setup.renderOnce() })
    }
  }
  const checkMenuPosition = () => {
    const menu = setup.renderer.root.findDescendantById("command-menu")!
    const textarea = textareaRenderable(setup.renderer.root)
    expect(menu.y).toBeGreaterThanOrEqual(1)
    expect(menu.y + menu.height).toBeLessThan(textarea.y)
    expect(textarea.focused).toBe(true)
  }

  try {
    await render()
    const textarea = textareaRenderable(setup.renderer.root)
    await act(async () => { await setup.mockInput.typeText("@sr") })
    await render()
    expect(setup.captureCharFrame()).toContain("Searching paths...")
    checkMenuPosition()
    await act(async () => { await Bun.sleep(30); releaseSearch(); await gate })
    await render()
    expect(queries).toEqual(["sr"])
    expect(setup.captureCharFrame()).toContain("→ src/file-0.ts")
    checkMenuPosition()

    act(() => setup.mockInput.pressArrow("up"))
    await render()
    expect(setup.captureCharFrame()).toContain("→ src/file-29.ts")
    expect(setup.captureCharFrame()).not.toContain("src/file-0.ts")
    for (const [width, height] of [[40, 10], [120, 30], [40, 14]] as const) {
      act(() => setup.resize(width, height))
      await render()
      expect(setup.captureCharFrame()).toContain("→ src/file-29.ts")
      expect(setup.captureCharFrame()).toContain("[ Test : medium ]")
      checkMenuPosition()
    }
    act(() => setup.mockInput.pressEnter())
    await render()
    expect(controller.getSnapshot().menu).toBeNull()
    expect(textareaRenderable(setup.renderer.root)).toBe(textarea)
    expect(textarea.plainText).toBe("@src/file-29.ts ")
    expect(controller.getInputDraft().references).toEqual([{
      type: "path",
      kind: "file",
      path: "/workspace/src/file-29.ts",
      source: { value: "@src/file-29.ts", start: 0, end: 15 },
    }])
    expect(fake.prompts).toHaveLength(0)
    expect(textarea.focused).toBe(true)
  } finally {
    releaseSearch()
    act(() => setup.renderer.destroy())
    controller.dispose()
  }
})

test("navigation subscribers ignore draft and menu updates but observe route and authentication changes", async () => {
  const { application } = fakeApplication()
  const controller = new BuliUiController({ application })
  const navigationRenders: ReturnType<typeof useBuliNavigationSnapshot>[] = []
  const draftText = "Draft zażółć 🐍 日本語"
  const firstSessionRoute = { type: "session", sessionId: "first-session" } as const
  const secondSessionRoute = { type: "session", sessionId: "second-session" } as const

  function NavigationProbe() {
    navigationRenders.push(useBuliNavigationSnapshot())
    return null
  }

  function DraftProbe() {
    const ui = useBuliUiSnapshot()
    return createElement("text", null, ui.input)
  }

  const setup = await testRender(
    createElement(BuliUiControllerProvider, {
      controller,
      children: createElement(
        "box",
        null,
        createElement(NavigationProbe),
        createElement(DraftProbe),
      ),
    }),
    { width: 80, height: 24 },
  )
  const updateAndRender = async (update: () => void | Promise<void>) => {
    await act(async () => { await update() })
    await act(async () => { await setup.renderOnce() })
  }

  try {
    await act(async () => { await setup.renderOnce() })
    expect(navigationRenders.at(-1)).toEqual({
      route: { type: "home" },
      authenticationMode: null,
    })
    const initialRenderCount = navigationRenders.length

    await updateAndRender(() => controller.updateInput(draftText))
    expect(setup.captureCharFrame()).toContain(draftText)
    expect(navigationRenders).toHaveLength(initialRenderCount)

    await updateAndRender(() => controller.updateInput("/"))
    const menu = controller.getSnapshot().menu
    expect(menu?.mode).toBe("commands")
    expect(navigationRenders).toHaveLength(initialRenderCount)

    await updateAndRender(() => controller.moveMenuSelection(1))
    expect(controller.getSnapshot().menu?.selectedIndex).not.toBe(menu?.selectedIndex)
    expect(navigationRenders).toHaveLength(initialRenderCount)

    await updateAndRender(() => controller.updateInput(draftText))
    expect(setup.captureCharFrame()).toContain(draftText)
    expect(navigationRenders).toHaveLength(initialRenderCount)

    const transitions = [
      {
        update: () => controller.activateSession(firstSessionRoute.sessionId),
        expected: { route: firstSessionRoute, authenticationMode: null },
      },
      {
        update: () => controller.activateSession(secondSessionRoute.sessionId),
        expected: { route: secondSessionRoute, authenticationMode: null },
      },
      {
        update: () => controller.openAuthentication("login"),
        expected: { route: secondSessionRoute, authenticationMode: "login" },
      },
      {
        update: () => controller.openAuthentication("logout"),
        expected: { route: secondSessionRoute, authenticationMode: "logout" },
      },
      {
        update: () => controller.closeAuthentication(),
        expected: { route: secondSessionRoute, authenticationMode: null },
      },
      {
        update: () => controller.goHome(),
        expected: { route: { type: "home" }, authenticationMode: null },
      },
    ] as const
    for (const { update, expected } of transitions) {
      const previousRenderCount = navigationRenders.length
      await updateAndRender(update)
      expect(navigationRenders.length).toBeGreaterThan(previousRenderCount)
      expect(navigationRenders.at(-1)).toEqual(expected)
      expect(setup.captureCharFrame()).toContain(draftText)
    }
  } finally {
    act(() => { setup.renderer.destroy() })
    controller.dispose()
  }
})

test("typing through BuliTui does not reread unchanged session state", async () => {
  const { application } = fakeApplication()
  const controller = new BuliUiController({ application })
  const sessionId = "typing-session"
  await controller.activateSession(sessionId)
  const setup = await testRender(buliElementWithController(application, controller), {
    width: 80, height: 24,
  })
  const snapshotReads = spyOn(application.openSession(sessionId), "getSnapshot")

  try {
    await act(async () => {
      await setup.renderOnce()
      await setup.waitForVisualIdle()
    })
    const textarea = textareaRenderable(setup.renderer.root)
    snapshotReads.mockClear()

    await act(async () => { setup.mockInput.pressKey("x") })
    await act(async () => { await setup.renderOnce() })

    expect(controller.getSnapshot().input).toBe("x")
    expect(textarea.plainText).toBe("x")
    expect(textareaRenderable(setup.renderer.root)).toBe(textarea)
    expect(setup.captureCharFrame()).toContain("Start conversation")
    expect(snapshotReads).not.toHaveBeenCalled()
  } finally {
    act(() => { setup.renderer.destroy() })
    snapshotReads.mockRestore()
    controller.dispose()
  }
})

test("provides the runtime above Buli", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "buli-tui-"))
  const startup = await createBuliApplication({
    signal: new AbortController().signal,
    workspaceRoot: workspace,
    manager: new SQLiteSessionManager({ databasePath: ":memory:" }),
    model: { async *stream() {} },
    tools: [],
  })
  const { runtime } = startup
  const setup = await testRender(
    buliElement(runtime),
    { width: 80, height: 24 },
  )

  try {
    expect(runtime.getSnapshot().agents).toEqual([
      { id: "buli", name: "Buli" },
      { id: "novibe", name: "NoVibe" },
    ])

    await act(async () => {
      await setup.renderOnce()
    })
    const frame = setup.captureCharFrame()

    expect(frame.trim()).not.toBe("")
    expect(frame).not.toContain("Buli runtime not available")
    expect(frame).toContain("____")
    expect(textareaRenderable(setup.renderer.root).placeholder).toBeNull()
    expect(runtime.listSessions()).toEqual([])
  } finally {
    await startup.dispose()
    await rm(workspace, { recursive: true, force: true })
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test.each([
  { status: "loading", message: "Loading account models", label: "Loading models" },
  { status: "error", message: "Catalog unavailable", label: "Model unavailable" },
  { status: "ready", message: "Fast unavailable; using Astra Standard", label: "GPT-6 Astra" },
] as const)("keeps catalog $status visible without disabling login or editing", async ({ status, message, label }) => {
  const fake = fakeApplication({
    applicationSnapshot: {
      ...APPLICATION_SNAPSHOT,
      models: status === "ready" ? [{
        id: "gpt-6-astra",
        name: "GPT-6 Astra",
        reasoningEfforts: ["low"],
      }] : [],
      selection: { modelId: "gpt-6-astra", reasoningEffort: "low" },
      modelCatalog: { status, message },
    },
  })
  const controller = new BuliUiController({ application: fake.application })
  const setup = await testRender(buliElementWithController(fake.application, controller), {
    width: 80,
    height: 24,
  })

  try {
    await act(async () => {
      await setup.renderOnce()
      await setup.mockInput.typeText("draft")
      await setup.renderOnce()
    })
    expect(setup.captureCharFrame()).toContain(message)
    expect(setup.captureCharFrame()).toContain(label)
    expect(setup.captureCharFrame()).not.toContain("GPT-6 Astra Fast / low")
    expect(textareaRenderable(setup.renderer.root).plainText).toBe("draft")
    expect(textareaRenderable(setup.renderer.root).focused).toBe(true)

    await act(async () => {
      setup.resize(36, 24)
      await setup.renderOnce()
    })
    expect(setup.captureCharFrame()).toContain(label)
    expect(setup.captureCharFrame()).not.toMatch(/undefined|NaN/)

    // Readiness is enforced by runtime, not by disabling the editor. The actual
    // command dispatch must still open authentication when no model is available.
    await act(async () => {
      await controller.submitInput("/login")
      await setup.renderOnce()
    })
    expect(controller.getSnapshot().authenticationMode).toBe("login")
    expect(fake.prompts).toEqual([])
  } finally {
    controller.dispose()
    act(() => setup.renderer.destroy())
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

test("two Escape keypresses close the menu before interrupting an active response", async () => {
  let cleared = 0
  const fake = fakeApplication({
    sessionSnapshot: {
      activeBranchId: "main",
      messages: [],
      pendingSteeringMessages: [{
        id: "steer-1", sessionId: "default", runId: "run-1", role: "user",
        source: "steer", content: "Queued steering", createdAt: 1,
      }],
      pendingFollowUpMessages: [{
        id: "follow-up-1", sessionId: "default", runId: "run-1", role: "user",
        source: "followUp", content: "Queued follow-up", createdAt: 2,
      }],
      isRunning: true, isCompacting: false, pendingToolCallIds: [],
    },
    clearQueuedMessages: () => {
      cleared += 1
      return { steering: ["Queued steering"], followUp: ["Queued follow-up"] }
    },
  })
  const controller = new BuliUiController({ application: fake.application })
  await controller.activateSession("default")
  const setup = await testRender(buliElementWithController(fake.application, controller), {
    width: 80, height: 24,
  })

  try {
    await act(async () => {
      await setup.renderOnce()
      await setup.mockInput.typeText("/")
      await setup.renderOnce()
    })
    expect(controller.getSnapshot().menu).not.toBeNull()
    const draft = controller.getInputDraft()
    const session = fake.application.openSession("default").getSnapshot()
    const pressEscape = async () => {
      const key = parseKeypress("\u001b")
      if (!key) throw new Error("Expected Escape to parse")
      await act(async () => {
        setup.renderer.keyInput.processParsedKey(key)
        await setup.renderOnce()
      })
    }

    await pressEscape()
    expect(controller.getSnapshot().menu).toBeNull()
    expect(controller.getInputDraft()).toBe(draft)
    expect(textareaRenderable(setup.renderer.root).plainText).toBe("/")
    expect(fake.application.openSession("default").getSnapshot()).toBe(session)
    expect(cleared).toBe(0)
    expect(fake.aborted).toEqual([])

    await pressEscape()
    expect(cleared).toBe(1)
    expect(fake.aborted).toEqual(["default"])
    expect(textareaRenderable(setup.renderer.root).plainText).toBe(
      "Queued steering\n\nQueued follow-up\n\n/",
    )
  } finally {
    controller.dispose()
    act(() => setup.renderer.destroy())
  }
})

test("Ctrl+D toggles console without deleting focused chat text", async () => {
  const fake = fakeApplication()
  const setup = await testRender(
    buliElement(fake.application, "default"),
    { width: 80, height: 24 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()
      await setup.mockInput.typeText("abcd")
      setup.mockInput.pressArrow("left")
      setup.mockInput.pressArrow("left")
    })
    const textarea = textareaRenderable(setup.renderer.root)
    const wasConsoleVisible = setup.renderer.console.visible

    await act(async () => {
      setup.mockInput.pressKey("d", { ctrl: true })
      await setup.renderOnce()
    })

    expect(setup.renderer.console.visible).toBe(!wasConsoleVisible)
    expect(textarea.plainText).toBe("abcd")
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

test("retains textarea input until persistence and clears it afterward", async () => {
  const persistence = Promise.withResolvers<void>()
  const fake = fakeApplication({
    submitPrompt: () => ({
      sessionId: "default",
      runId: "run-1",
      promptPersisted: persistence.promise,
      runFinished: persistence.promise,
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
      persistence.resolve()
      await persistence.promise
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
  const persistence = Promise.withResolvers<void>()
  const fake = fakeApplication({
    submitPrompt: () => ({
      sessionId: "default",
      runId: "run-1",
      promptPersisted: persistence.promise,
      runFinished: persistence.promise,
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
      persistence.resolve()
      await persistence.promise
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

test("restores a replacement Home draft after persistence opens its session", async () => {
  const persistence = Promise.withResolvers<void>()
  const fake = fakeApplication({
    submitPrompt: () => ({
      sessionId: "default",
      runId: "run-1",
      promptPersisted: persistence.promise,
      runFinished: persistence.promise,
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
      persistence.resolve()
      await persistence.promise
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

test("retains textarea input when prompt persistence fails", async () => {
  const persistence = Promise.withResolvers<void>()
  const fake = fakeApplication({
    submitPrompt: () => ({
      sessionId: "default",
      runId: "run-1",
      promptPersisted: persistence.promise,
      runFinished: persistence.promise,
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
      persistence.reject(new Error("Failed to persist prompt"))
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
      activeBranchId: "main",
      messages: [],
      pendingSteeringMessages: [],
      pendingFollowUpMessages: [],
      isRunning: true,
      isCompacting: false,
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

test("notifies when a run finishes while authentication replaces the session", async () => {
  let currentTime = 0
  const fake = fakeApplication({
    sessionSnapshot: {
      activeBranchId: "main",
      messages: [],
      pendingSteeringMessages: [],
      pendingFollowUpMessages: [],
      isRunning: true,
      isCompacting: false,
      activeRunId: "run-1",
      pendingToolCallIds: [],
    },
  })
  const controller = new BuliUiController({ application: fake.application })
  controller.activateSession("default")
  const setup = await testRender(
    buliElementWithController(fake.application, controller, {
      now: () => currentTime,
    }),
    { width: 80, height: 24 },
  )
  const notifications: Array<{ message: string; title?: string }> = []
  setup.renderer.triggerNotification = (message, title) => {
    notifications.push({ message, ...(title === undefined ? {} : { title }) })
    return false
  }

  try {
    await act(async () => {
      await setup.renderOnce()
      setup.renderer.emit("blur")
      controller.openAuthentication("login")
      await setup.renderOnce()
    })
    expect(setup.captureCharFrame()).toContain("Buli Authentication")

    currentTime = COMPLETION_NOTIFICATION_MIN_DURATION_MS
    await act(async () => {
      fake.setSessionSnapshot({
        activeBranchId: "main",
        messages: [],
        pendingSteeringMessages: [],
        pendingFollowUpMessages: [],
        isRunning: false,
        isCompacting: false,
        pendingToolCallIds: [],
        lastRunReason: "completed",
      })
      await setup.renderOnce()
    })

    expect(notifications).toEqual([{
      message: "Run finished",
      title: "Buli",
    }])
  } finally {
    controller.dispose()
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("retains textarea input and allows Escape while compacting", async () => {
  const fake = fakeApplication({
    sessionSnapshot: {
      activeBranchId: "main",
      messages: [],
      pendingSteeringMessages: [],
      pendingFollowUpMessages: [],
      isRunning: false,
      isCompacting: true,
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
      await setup.mockInput.typeText("Wait for compaction")
      setup.mockInput.pressEnter()
      await Promise.resolve()
      await setup.renderOnce()
    })

    expect(fake.prompts).toEqual([])
    expect(fake.steering).toEqual([])
    expect(textareaRenderable(setup.renderer.root).plainText).toBe(
      "Wait for compaction",
    )
    expect(setup.captureCharFrame()).toContain("Cannot submit input while")
    expect(setup.captureCharFrame()).toContain("Compacting context")

    const escape = parseKeypress("\u001b")
    if (!escape) throw new Error("Expected Escape to parse as a keypress")
    await act(async () => {
      setup.renderer.keyInput.processParsedKey(escape)
      await setup.renderOnce()
    })
    expect(fake.aborted).toEqual(["default"])
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("submits Alt+Enter input as follow-up while the session is running", async () => {
  const fake = fakeApplication({
    sessionSnapshot: {
      activeBranchId: "main",
      messages: [],
      pendingSteeringMessages: [],
      pendingFollowUpMessages: [],
      isRunning: true,
      isCompacting: false,
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
      activeBranchId: "main",
      messages: [],
      pendingSteeringMessages: [],
      pendingFollowUpMessages: [],
      isRunning: true,
      isCompacting: false,
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
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Agent is not accepting")
    expect(frame).toContain("steering messages")
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("renders running and failed session status", async () => {
  const fake = fakeApplication({
    sessionSnapshot: {
      activeBranchId: "main",
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
      isCompacting: false,
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
    await act(async () => { await setup.renderOnce() })
    const runningFrame = setup.captureCharFrame().replace(/[│\s]+/g, " ")
    expect(runningFrame).not.toContain("Working...")
    expect(runningFrame).toContain("[ Enter ] steer")
    expect(runningFrame).toContain("[ Alt + Enter ] follow-up")
    expect(runningFrame).toContain("[ Esc ] stop")
    expect(runningFrame).toContain(glyphs.snakeHead)
    expect(runningFrame).toContain(glyphs.snakeBody)
    expect(runningFrame).toContain(glyphs.snakeEmptyTrack)
    expect(runningFrame).toContain("Steering")
    expect(runningFrame).toContain("Adjust the")
    expect(runningFrame).toContain("answer")
    expect(runningFrame).toContain("Follow-up")
    expect(runningFrame).toContain("summarize it")
    expect(runningFrame.replace(/[│\s]+/g, " ")).toContain("stop and restore queued input")
    expect(runningFrame).toContain("queued input")

    await act(async () => {
      fake.setSessionSnapshot({
        activeBranchId: "main",
        messages: [],
        pendingSteeringMessages: [],
        pendingFollowUpMessages: [],
        isRunning: false,
        isCompacting: false,
        pendingToolCallIds: [],
        lastRunReason: "error",
        errorMessage: "Provider request failed",
      })
      await setup.renderOnce()
    })

    const frame = setup.captureCharFrame()
    expect(frame).not.toContain(
      "Enter steer | Alt+Enter follow-up | Esc stop",
    )
    expect(frame).not.toContain(glyphs.snakeHead)
    expect(frame).toContain("Provider request failed")
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("keeps a long scrollable queue above menus without displacing the editor and context status", async () => {
  const fake = fakeApplication({
    applicationSnapshot: {
      ...APPLICATION_SNAPSHOT,
      models: [{ id: "test", name: "GPT-6 Astra Fast", reasoningEfforts: ["medium"] }],
    },
  })
  const initial = fake.getSessionData()
  const pending = Array.from({ length: 6 }, (_, index) => ({
    id: `queued-${index}`,
    sessionId: "default",
    runId: "run-1",
    role: "user" as const,
    source: "followUp" as const,
    content: `Queued message ${index}\n${"Complete wrapped text ".repeat(15)}\nqueue-end-${index}`,
    createdAt: index,
  }))
  const activeSession: ISessionTestData = {
    ...initial,
    isRunning: true,
    pendingSteeringMessages: [{ ...pending[0]!, source: "steer" }],
    pendingFollowUpMessages: pending.slice(1),
    contextUsage: {
      estimatedInputTokens: 142_000,
      compactionInputTokens: 142_000,
      contextWindowTokens: 200_000,
      compactionThresholdTokens: 160_000,
      remainingTokens: 58_000,
      usageRatio: 0.71,
      shouldCompact: false,
    },
  }
  fake.setSessionSnapshot(activeSession)
  const controller = new BuliUiController({ application: fake.application })
  await controller.activateSession("default")
  controller.updateInput("/")
  controller.moveMenuSelection(-1)
  const setup = await testRender(buliElementWithController(fake.application, controller), {
    width: 80, height: 24,
  })
  const render = async () => {
    // Let React commits and OpenTUI layout settle before checking scrolling behavior.
    for (let frame = 0; frame < 4; frame++) {
      await act(async () => { await setup.renderOnce() })
    }
  }
  try {
    await render()
    const textarea = textareaRenderable(setup.renderer.root)
    const scroll = setup.renderer.root.findDescendantById("queued-messages-scroll") as ScrollBoxRenderable
    await act(async () => {
      await setup.mockMouse.scroll(scroll.x + 2, scroll.y + 2, "down")
    })
    await render()
    expect(scroll.scrollTop).toBeGreaterThan(0)
    expect(textarea.focused).toBe(true)

    for (const isCompacting of [false, true]) {
      act(() => fake.setSessionSnapshot({ ...activeSession, isCompacting }))
      for (const [width, height] of [[80, 24], [40, 14], [40, 10], [120, 30], [40, 14]] as const) {
        act(() => setup.resize(width, height))
        await render()
        const queue = setup.renderer.root.findDescendantById("queued-messages")!
        expect(setup.renderer.root.findDescendantById("queued-messages-hint")).toBeUndefined()
        const menu = setup.renderer.root.findDescendantById("command-menu")!
        const activity = setup.renderer.root.findDescendantById("chat-activity")!
        const status = setup.renderer.root.findDescendantById("chat-status")!
        const queueRows = queue.getLayoutNode().getComputedHeight()
        const scrollRows = scroll.getLayoutNode().getComputedHeight()
        expect(queue.y + queueRows).toBeLessThanOrEqual(menu.y)
        expect(menu.y + menu.height).toBeLessThanOrEqual(textarea.parent!.y)
        expect(textarea.parent!.y + textarea.parent!.height).toBeLessThanOrEqual(status.y)
        const snake = setup.renderer.root.findDescendantById("chat-activity-snake")!
        expect(menu.y + menu.height).toBeLessThanOrEqual(activity.y)
        expect(activity.y).toBe(snake.y)
        expect(snake.x + snake.width).toBeLessThanOrEqual(activity.x)
        expect(activity.y + activity.height).toBeLessThanOrEqual(textarea.parent!.y)
        expect(snake.y + snake.height).toBeLessThanOrEqual(textarea.parent!.y)
        expect(status.y + status.height).toBeLessThanOrEqual(height)
        expect(scrollRows).toBeLessThanOrEqual(Math.min(10, Math.floor(height / 3)))
        expect(textareaRenderable(setup.renderer.root)).toBe(textarea)
        expect(textarea.focused).toBe(true)
        expect(textarea.plainText).toBe("/")
        const frame = setup.captureCharFrame()
        expect(frame.split("\n")[0]!.trim()).toBe(WORKSPACE_ROOT)
        expect(frame).toContain("→ novibe")
        expect(frame.replace(/\s+/g, "")).toContain("ctx~142k/200k(71%)")
        expect(frame.match(/ctx ~/g)).toHaveLength(1)
        expect(frame.split(glyphs.snakeHead).length - 1).toBe(1)
        expect(frame).not.toContain("budget)")
        if (isCompacting && height > 12) expect(frame).toContain("Compacting context")
        expect(textarea.y + textarea.height).toBeLessThan(height)
        if (scrollRows > 0) {
          expect(scroll.y + scrollRows).toBeLessThanOrEqual(menu.y)
          act(() => scroll.scrollTo(scroll.scrollHeight))
          await render()
          // At one row, the bottom of a complete card is its border, not its text.
          if (scrollRows === 1) {
            act(() => scroll.scrollBy(-1))
            await render()
          }
          expect(setup.captureCharFrame()).toContain("queue-end-5")
          expect(setup.captureCharFrame().split("\n")[0]!.trim()).toBe(WORKSPACE_ROOT)
        } else {
          expect(frame).not.toContain("queue-end-")
        }
      }
    }
    act(() => fake.setSessionSnapshot({ ...activeSession, pendingSteeringMessages: [], pendingFollowUpMessages: [] }))
    await render()
    expect(setup.renderer.root.findDescendantById("queued-messages")).toBeUndefined()
    expect(setup.captureCharFrame()).not.toContain("Esc restores queued input")
    expect(textareaRenderable(setup.renderer.root)).toBe(textarea)
    expect(textarea.focused).toBe(true)
  } finally {
    act(() => setup.renderer.destroy())
    controller.dispose()
  }
})

test("keeps slash commands above the focused editor through narrow terminal resizes", async () => {
  const fake = fakeApplication({
    applicationSnapshot: {
      ...APPLICATION_SNAPSHOT,
      models: [{ id: "test", name: "GPT-6 Astra Fast", reasoningEfforts: ["medium"] }],
    },
    sessionSnapshot: {
      activeBranchId: "main",
      messages: [],
      pendingSteeringMessages: [],
      pendingFollowUpMessages: [],
      isRunning: true,
      isCompacting: false,
      activeRunId: "run-1",
      pendingToolCallIds: [],
      contextUsage: {
        estimatedInputTokens: 142_000,
        compactionInputTokens: 142_000,
        contextWindowTokens: 200_000,
        compactionThresholdTokens: 160_000,
        remainingTokens: 58_000,
        usageRatio: 0.71,
        shouldCompact: false,
      },
    },
  })
  const controller = new BuliUiController({ application: fake.application })
  controller.activateSession("default")
  const setup = await testRender(
    buliElementWithController(fake.application, controller),
    { width: 80, height: 14 },
  )
  const render = async () => {
    // Settle native text wrapping, then paint the measured React menu window.
    for (let frame = 0; frame < 3; frame++) {
      await act(async () => { await setup.renderOnce() })
    }
  }

  try {
    await act(async () => {
      await setup.renderOnce()
      await setup.mockInput.typeText("/")
      setup.mockInput.pressArrow("up")
    })
    await render()

    const textarea = textareaRenderable(setup.renderer.root)
    const checkLayout = (height: number) => {
      const frame = setup.captureCharFrame()
      const menu = setup.renderer.root.findDescendantById("command-menu")!
      const activity = setup.renderer.root.findDescendantById("chat-activity")
      const status = setup.renderer.root.findDescendantById("chat-status")!
      expect(Boolean(activity)).toBe(fake.application.openSession("default").getSnapshot().isRunning)
      expect(frame).toContain("→ novibe")
      expect(frame.replace(/\s+/g, ""))
        .toContain("ctx~142k/200k(71%)")
      expect(frame).not.toContain("budget)")
      expect(frame.match(/ctx ~/g)).toHaveLength(1)
      expect(menu.y).toBeGreaterThanOrEqual(1)
      expect(menu.y + menu.height).toBeLessThanOrEqual(textarea.parent!.y)
      expect(textarea.parent!.y + textarea.parent!.height).toBeLessThanOrEqual(status.y)
      expect(status.y + status.height).toBeLessThanOrEqual(height)
      if (activity) {
        const snake = setup.renderer.root.findDescendantById("chat-activity-snake")!
        expect(menu.y + menu.height).toBeLessThanOrEqual(activity.y)
        expect(activity.y).toBe(snake.y)
        expect(snake.x + snake.width).toBeLessThanOrEqual(activity.x)
        expect(activity.y + activity.height).toBeLessThanOrEqual(textarea.parent!.y)
        expect(snake.y + snake.height).toBeLessThanOrEqual(textarea.parent!.y)
        expect(frame).not.toContain("During generation")
        if (height <= 12) {
          expect(activity.height).toBe(1)
          expect(frame).toContain("[ Esc ] close menu")
          expect(frame).not.toContain("[ Enter ]")
        } else {
          expect(activity.height).toBeGreaterThanOrEqual(1)
          expect(frame.replace(/[│\s]+/g, " ")).toContain("[ Alt + Enter ]")
        }
      }
      expect(textarea.y + textarea.height).toBeLessThan(height)
      expect(textareaRenderable(setup.renderer.root)).toBe(textarea)
      expect(textarea.focused).toBe(true)
      expect(textarea.plainText).toBe("/")
    }
    checkLayout(14)

    for (const [width, height] of [[40, 14], [40, 12], [40, 13], [40, 10], [120, 30], [80, 14]] as const) {
      act(() => setup.resize(width, height))
      await render()
      checkLayout(height)
      const resizedFrame = setup.captureCharFrame()
      if (height === 30) {
        for (const commandName of [
          "new", "model", "reasoning", "sessions", "login", "logout",
          "branch", "return",
        ]) {
          expect(resizedFrame).toContain(`   ${commandName}`)
        }
      } else {
        expect(resizedFrame).not.toContain("   new")
      }
    }

    const activeSession = fake.getSessionData()
    act(() => fake.setSessionSnapshot({ ...activeSession, isRunning: false }))
    await render()
    checkLayout(14)
    expect(setup.captureCharFrame()).not.toContain(glyphs.snakeHead)

    act(() => fake.setSessionSnapshot(activeSession))
    await render()
    checkLayout(14)
    expect(setup.captureCharFrame()).toContain(glyphs.snakeHead)

    act(() => setup.mockInput.pressArrow("down"))
    await render()
    expect(setup.captureCharFrame()).toContain("→ new")
  } finally {
    controller.dispose()
    act(() => setup.renderer.destroy())
  }
})

test("shows slash commands and executes the selected new command", async () => {
  const runtime = new BuliApplicationRuntime({
    workspaceRoot: WORKSPACE_ROOT,
    manager: new SQLiteSessionManager({ databasePath: ":memory:" }),
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
      defaultReasoningEffort: "medium",
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
  }).runFinished
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
    expect(frame).toContain("→ new")

    await act(async () => {
      const enter = parseKeypress("\r")
      if (!enter) throw new Error("Expected Enter to parse as a keypress")
      setup.renderer.keyInput.processParsedKey(enter)
      await setup.renderOnce()
    })

    expect(setup.captureCharFrame()).not.toContain("Old prompt")
    expect(runtime.openSession(session.id).loadHistoryPage("main").messages).toHaveLength(2)
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
    manager: new SQLiteSessionManager({ databasePath: ":memory:" }),
    agents: TEST_AGENTS,
    defaultAgentId: TEST_AGENT_ID,
    models: [
      {
        id: "test",
        name: "Test",
        model,
        reasoningEfforts: ["medium"],
        defaultReasoningEffort: "medium",
      },
      {
        id: "other",
        name: "Other",
        model,
        reasoningEfforts: ["medium"],
        defaultReasoningEffort: "medium",
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

    await act(async () => { await setup.renderOnce() })
    expect(setup.captureCharFrame()).toContain("→ Test")
    const menu = setup.renderer.root.findDescendantById("command-menu")!
    const textarea = textareaRenderable(setup.renderer.root)
    expect(menu.y + menu.height).toBeLessThan(textarea.y)
    expect(textarea.focused).toBe(true)

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
    manager: new SQLiteSessionManager({ databasePath: ":memory:" }),
    agents: TEST_AGENTS,
    defaultAgentId: TEST_AGENT_ID,
    models: [{
      id: "test",
      name: "Test",
      model,
      reasoningEfforts: ["medium"],
      defaultReasoningEffort: "medium",
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
      }).runFinished
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
    expect(frame).not.toContain("model")
    expect(frame).toContain("[ Test : medium ]")
    expect(frame).not.toContain("reasoning")
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
    manager: new SQLiteSessionManager({ databasePath: ":memory:" }),
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
      defaultReasoningEffort: "medium",
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
  }).runFinished
  const second = runtime.createSession({
    agentId: TEST_AGENT_ID,
    title: "Second history",
  })
  await runtime.submitPrompt({
    sessionId: second.id,
    text: "Second history",
  }).runFinished
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

    await act(async () => { await setup.renderOnce() })
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
