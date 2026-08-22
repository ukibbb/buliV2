import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"

import { BuliApplicationLifecycle } from "@/app/ui/shell/BuliApplicationLifecycle"

test("renders startup failure instead of leaving a blank screen", async () => {
  const startup = Promise.withResolvers<never>()
  const setup = await testRender(
    <BuliApplicationLifecycle
      runtimeTask={startup.promise}
      openUrl={() => {}}
    />,
    { width: 80, height: 24 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()
    })
    expect(setup.captureCharFrame()).toContain("Starting Buli...")

    await act(async () => {
      startup.reject(new Error("Missing OPENAI_API_KEY"))
      await Promise.resolve()
    })

    const frame = await setup.waitForFrame(
      (value) => value.includes("Failed to start Buli"),
    )
    expect(frame.trim()).not.toBe("")
    expect(frame).toContain("Failed to start Buli")
    expect(frame).toContain("Missing OPENAI_API_KEY")
    expect(frame).toContain("Press Ctrl+C to exit")
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})
