import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act, createElement } from "react"

import { BuliRuntimeProvider, createBuliApplication } from "@/application-state"
import { BuliTui } from "@/tui/Buli"

test("provides the runtime above Buli", async () => {
  const runtime = await createBuliApplication({
    signal: new AbortController().signal,
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
    act(() => {
      setup.renderer.destroy()
    })
  }
})
