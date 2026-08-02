import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act, createElement } from "react"

import {
  BuliEngine,
  BuliRuntime,
  BuliSessionRead,
  BuliTuiRoot,
} from "@/tui"

test("provides the runtime above Buli", async () => {
  const runtime = new BuliRuntime(new BuliEngine(), new BuliSessionRead())
  const setup = await testRender(
    createElement(BuliTuiRoot, { runtime, sessionId: "test-session" }),
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
    act(() => {
      setup.renderer.destroy()
    })
  }
})
