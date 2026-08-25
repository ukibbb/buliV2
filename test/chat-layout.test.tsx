import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"

import { ChatStatus } from "@/app/ui/chat/ChatStatus"
import { CommandMenu } from "@/app/ui/chat/CommandMenu"

test("keeps errors readable beside a long model name", async () => {
  const setup = await testRender(
    <ChatStatus
      isRunning={false}
      isCompacting={false}
      contextUsage={undefined}
      pendingSteeringMessages={[]}
      pendingFollowUpMessages={[]}
      pendingToolApproval={undefined}
      lastRunReason="error"
      errorMessage="Critical provider failure"
      inputError={null}
      selectedModelName="An exceptionally long provider model name"
      reasoningEffort="medium"
    />,
    { width: 30, height: 10 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()
    })

    const frame = setup.captureCharFrame()
    expect(frame).toContain("Critical")
    expect(frame).toContain("provider")
    expect(frame).toContain("failure")
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("renders compaction lifecycle and estimated context usage", async () => {
  const setup = await testRender(
    <ChatStatus
      isRunning
      isCompacting
      contextUsage={{
        estimatedInputTokens: 142_000,
        contextWindowTokens: 200_000,
        compactionThresholdTokens: 160_000,
        remainingTokens: 58_000,
        usageRatio: 0.71,
        shouldCompact: false,
      }}
      pendingSteeringMessages={[]}
      pendingFollowUpMessages={[]}
      pendingToolApproval={undefined}
      lastRunReason={undefined}
      errorMessage={undefined}
      inputError={null}
      selectedModelName="GPT-5.6 Sol"
      reasoningEffort="medium"
    />,
    { width: 100, height: 10 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()
    })

    const frame = setup.captureCharFrame()
    expect(frame).toContain("Compacting context | Esc stop")
    expect(frame).toContain("ctx ~142k/200k (71%)")
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
