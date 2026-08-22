import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"

import { ChatStatus } from "@/app/ui/chat/ChatStatus"
import { CommandMenu } from "@/app/ui/chat/CommandMenu"

test("keeps errors readable beside a long model name", async () => {
  const setup = await testRender(
    <ChatStatus
      isRunning={false}
      pendingSteeringMessages={[]}
      pendingFollowUpMessages={[]}
      pendingToolApproval={undefined}
      lastRunReason="error"
      errorMessage="Critical provider failure"
      inputError={null}
      selectedModelName="An exceptionally long provider model name"
      reasoningEffort="medium"
      menuOpen={false}
    />,
    { width: 30, height: 10 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()
    })

    const frame = setup.captureCharFrame()
    expect(frame).toContain("Critical provider")
    expect(frame).toContain("failure")
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("keeps the selected command visible on a short terminal", async () => {
  const setup = await testRender(
    <CommandMenu
      menu={{
        mode: "commands",
        selectedIndex: 9,
        errorMessage: null,
        items: Array.from({ length: 10 }, (_, index) => ({
          id: `command-${index}`,
          label: `command-${index}`,
        })),
      }}
    />,
    { width: 40, height: 14 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()
    })

    const frame = setup.captureCharFrame()
    expect(frame).toContain("→ command-9")
    expect(frame).not.toContain("command-0")
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})
