import { expect, test } from "bun:test"
import { parseKeypress } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { act, createElement } from "react"

import {
  BuliApplicationRuntime,
  createBuliApplication,
  type IBuliApplicationClient,
} from "@/application"
import { BuliRuntimeProvider } from "@/application-state"
import type { ISessionSnapshot } from "@/domain"
import type { IUserBuliInteractionDriver } from "@/engine/interaction-driver"
import { SessionEngine } from "@/engine/session-engine"
import { InMemorySessionStore } from "@/engine/session-store"
import { BuliTui } from "@/tui/Buli"

test("provides the runtime above Buli", async () => {
  const runtime = await createBuliApplication({
    signal: new AbortController().signal,
    store: new InMemorySessionStore(),
  })
  const setup = await testRender(
    createElement(BuliRuntimeProvider, {
      runtime,
      children: createElement(BuliTui),
    }),
    { width: 80, height: 24 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()
    })
    const frame = setup.captureCharFrame()

    expect(frame.trim()).not.toBe("")
    expect(frame).not.toContain("Buli runtime not available")
  } finally {
    runtime.dispose()
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("Escape aborts the default session while chat input is focused", async () => {
  const aborted: string[] = []
  const snapshot: ISessionSnapshot = { messages: [] }
  const view = {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
  }
  const runtime: IBuliApplicationClient = {
    submitPrompt: async () => undefined,
    abort: (sessionId) => aborted.push(sessionId),
    view: () => view,
  }
  const setup = await testRender(
    createElement(BuliRuntimeProvider, {
      runtime,
      children: createElement(BuliTui),
    }),
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

    expect(aborted).toEqual(["default"])
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("renders a submitted prompt and streamed response", async () => {
  const driver: IUserBuliInteractionDriver = {
    async *interaction() {
      yield { type: "text-start", id: "answer" }
      yield { type: "text-delta", id: "answer", delta: "Rendered response" }
      yield { type: "text-end", id: "answer" }
      yield { type: "finish", reason: "stop" }
    },
  }
  const runtime = new BuliApplicationRuntime({
    sessions: new SessionEngine({ driver }),
  })
  const setup = await testRender(
    createElement(BuliRuntimeProvider, {
      runtime,
      children: createElement(BuliTui),
    }),
    { width: 80, height: 24 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()
      await runtime.submitPrompt({ sessionId: "default", text: "Rendered prompt" })
      await setup.renderOnce()
    })

    const frame = setup.captureCharFrame()
    expect(frame).toContain("Rendered prompt")
    expect(frame).toContain("Rendered response")
  } finally {
    runtime.dispose()
    act(() => {
      setup.renderer.destroy()
    })
  }
})
