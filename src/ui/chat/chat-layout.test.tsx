import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"

import { ChatStatus } from "@/ui/chat/ChatStatus"
import { CommandMenu } from "@/ui/chat/CommandMenu"
import type { IContextUsage } from "@/sessions"
import { glyphs, theme } from "@/ui/terminal/theme"

test("keeps errors readable beside a long model name", async () => {
  const setup = await testRender(
    <ChatStatus
      isRunning={false}
      isCompacting={false}
      contextUsage={undefined}
      pendingSteeringMessages={[]}
      pendingFollowUpMessages={[]}
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
        compactionInputTokens: 142_000,
        contextWindowTokens: 200_000,
        compactionThresholdTokens: 160_000,
        remainingTokens: 58_000,
        usageRatio: 0.71,
        shouldCompact: false,
      }}
      pendingSteeringMessages={[]}
      pendingFollowUpMessages={[]}
      lastRunReason="error"
      errorMessage="Stale provider failure"
      inputError={null}
      selectedModelName="GPT-5.6 Sol"
      reasoningEffort="medium"
    />,
    { width: 120, height: 10 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()
    })

    const frame = setup.captureCharFrame()
    expect(frame).toContain("Compacting context · Esc stop")
    expect(frame).toContain(glyphs.snakeHead)
    expect(frame).toContain(glyphs.snakeBody)
    expect(frame).toContain("ctx ~142k/200k (71%)")
    expect(frame).toContain("compact 142k/160k (89% budget)")
    expect(frame).not.toContain("Stale provider failure")
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test.each([
  {
    name: "unanchored safety input near the threshold",
    usage: {
      estimatedInputTokens: 70_000,
      compactionInputTokens: 140_000,
      contextWindowTokens: 200_000,
      compactionThresholdTokens: 160_000,
      remainingTokens: 130_000,
      usageRatio: 0.35,
      shouldCompact: false,
    },
    expected: "ctx ~70k/200k (35%) · compact 140k/160k (88% budget)",
    expectedColor: theme.amber,
  },
  {
    name: "unanchored input at the safety threshold",
    usage: {
      estimatedInputTokens: 80_000,
      compactionInputTokens: 160_000,
      contextWindowTokens: 200_000,
      compactionThresholdTokens: 160_000,
      remainingTokens: 120_000,
      usageRatio: 0.4,
      shouldCompact: true,
    },
    expected: "ctx ~80k/200k (40%) · compact 160k/160k (100% budget)",
  },
  {
    name: "anchored input at the safety threshold",
    usage: {
      estimatedInputTokens: 160_000,
      compactionInputTokens: 160_000,
      contextWindowTokens: 200_000,
      compactionThresholdTokens: 160_000,
      remainingTokens: 40_000,
      usageRatio: 0.8,
      shouldCompact: true,
    },
    expected: "ctx ~160k/200k (80%) · compact 160k/160k (100% budget)",
  },
  {
    name: "zero input",
    usage: {
      estimatedInputTokens: 0,
      compactionInputTokens: 0,
      contextWindowTokens: 200_000,
      compactionThresholdTokens: 160_000,
      remainingTokens: 200_000,
      usageRatio: 0,
      shouldCompact: false,
    },
    expected: "ctx ~0/200k (0%) · compact 0/160k (0% budget)",
  },
  {
    name: "an unknown context window",
    usage: {
      estimatedInputTokens: 1_234,
      compactionInputTokens: 2_468,
      shouldCompact: false,
    },
    expected: "ctx ~1.2k · compact limit unknown",
  },
  {
    name: "zero input with an unknown context window",
    usage: {
      estimatedInputTokens: 0,
      compactionInputTokens: 0,
      shouldCompact: false,
    },
    expected: "ctx ~0 · compact limit unknown",
  },
  {
    name: "input above the context window",
    usage: {
      estimatedInputTokens: 220_000,
      compactionInputTokens: 440_000,
      contextWindowTokens: 200_000,
      compactionThresholdTokens: 160_000,
      remainingTokens: 0,
      usageRatio: 1.1,
      shouldCompact: true,
    },
    expected: "ctx ~220k/200k (110%) · compact 440k/160k (275% budget)",
  },
  {
    name: "a million-token window",
    usage: {
      estimatedInputTokens: 400_000,
      compactionInputTokens: 800_000,
      contextWindowTokens: 1_000_000,
      compactionThresholdTokens: 800_000,
      remainingTokens: 600_000,
      usageRatio: 0.4,
      shouldCompact: true,
    },
    expected: "ctx ~400k/1.0m (40%) · compact 800k/800k (100% budget)",
  },
  {
    name: "large million-token values",
    usage: {
      estimatedInputTokens: 5_000_000,
      compactionInputTokens: 10_000_000,
      contextWindowTokens: 10_000_000,
      compactionThresholdTokens: 8_000_000,
      remainingTokens: 5_000_000,
      usageRatio: 0.5,
      shouldCompact: true,
    },
    expected: "ctx ~5.0m/10m (50%) · compact 10m/8.0m (125% budget)",
  },
] satisfies { name: string; usage: IContextUsage; expected: string; expectedColor?: string }[])(
    "distinguishes the estimate from the compaction budget for $name",
    async (testCase) => {
      const { usage, expected } = testCase
      const expectedColor = "expectedColor" in testCase
        ? testCase.expectedColor
        : usage.shouldCompact ? theme.red : theme.textMuted
    const setup = await testRender(
      <ChatStatus
        isRunning={false}
        isCompacting={false}
        contextUsage={usage}
        pendingSteeringMessages={[]}
        pendingFollowUpMessages={[]}
        lastRunReason={undefined}
        errorMessage={undefined}
        inputError={null}
        selectedModelName="Model"
        reasoningEffort="medium"
      />,
      { width: 100, height: 4 },
    )

    try {
      await act(async () => {
        await setup.renderOnce()
      })

      expect(setup.captureCharFrame().trim()).toBe(`Model / medium · ${expected}`)
      const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
      expect(spans.find((span) => span.text.includes("ctx ~"))?.fg.equals(
        RGBA.fromHex(theme.textMuted),
      )).toBe(true)
      expect(spans.find((span) => span.text.includes("compact "))?.fg.equals(
        RGBA.fromHex(expectedColor),
      )).toBe(true)

      await act(async () => {
        setup.resize(40, 4)
        await setup.renderOnce()
      })

      const narrowFrame = setup.captureCharFrame()
      expect(narrowFrame).toContain("Model / medium")
      expect(narrowFrame.split("\n").map((line) => line.trim()).join(" "))
        .toContain(expected)
      expect(narrowFrame).not.toMatch(/NaN|Infinity|undefined/)
      expect(narrowFrame.split("\n").every((line) => line.length <= 40)).toBe(true)
      const budgetLabel = usage.compactionThresholdTokens === undefined
        ? "unknown"
        : "budget)"
      expect(narrowFrame).toContain(budgetLabel)
      const narrowSpans = setup.captureSpans().lines.flatMap((line) => line.spans)
      expect(narrowSpans.find((span) => span.text.includes(budgetLabel))?.fg.equals(
        RGBA.fromHex(expectedColor),
      )).toBe(true)
    } finally {
      act(() => {
        setup.renderer.destroy()
      })
    }
  },
)

test.each([40, 80])("keeps the active Astra budget readable at %i columns", async (width) => {
  const setup = await testRender(<ChatStatus
    isRunning
    isCompacting={false}
    contextUsage={{
      estimatedInputTokens: 80_000,
      compactionInputTokens: 160_000,
      contextWindowTokens: 200_000,
      compactionThresholdTokens: 160_000,
      remainingTokens: 120_000,
      usageRatio: 0.4,
      shouldCompact: true,
    }}
    pendingSteeringMessages={[]}
    pendingFollowUpMessages={[]}
    lastRunReason={undefined}
    errorMessage={undefined}
    inputError={null}
    selectedModelName="GPT-6 Astra Fast"
    reasoningEffort="high"
  />, { width, height: 12 })
  try {
    await act(async () => { await setup.renderOnce() })
    const frame = setup.captureCharFrame().split("\n").map((line) => line.trim()).join(" ")
    expect(frame).toContain("GPT-6 Astra Fast / high")
    expect(frame).toContain("ctx ~80k/200k (40%)")
    expect(frame).toContain("compact 160k/160k (100% budget)")
    const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
    expect(spans.some((span) => span.text.includes("budget)")
      && span.fg.equals(RGBA.fromHex(theme.red)))).toBe(true)
  } finally {
    act(() => setup.renderer.destroy())
  }
})

test("keeps the selected command and wrapped menu error visible on a short terminal", async () => {
  const setup = await testRender(
    <box width="100%" flexDirection="column">
      <box height={5} />
      <CommandMenu
        menu={{
          mode: "commands",
          selectedIndex: 9,
          errorMessage: "Could not refresh model catalog. Retry when connection is available.",
          items: Array.from({ length: 10 }, (_, index) => ({
            id: `command-${index}`,
            label: `command-${index}`,
            description: "A description that would wrap across several rows on a narrow terminal",
          })),
        }}
      />
    </box>,
    { width: 40, height: 14 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()
    })
    await act(async () => { await setup.renderOnce() })

    const frame = setup.captureCharFrame()
    expect(frame).toContain("→ command-9")
    expect(frame).not.toContain("command-0")
    expect(frame).toContain("Could not refresh model catalog.")
    expect(frame).toContain("available.")
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})
