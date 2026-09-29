import { expect, test } from "bun:test"
import { BoxRenderable, RGBA, ScrollBoxRenderable, TextRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { act, useState } from "react"

import type { IUserMessage } from "@/agent"
import { QueuedMessages } from "@/ui/chat/QueuedMessages"
import { ChatStatus } from "@/ui/chat/ChatStatus"
import { InputMenu } from "@/ui/chat/InputMenu"
import type { IContextUsage } from "@/sessions"
import type { TBuliMenuSnapshot } from "@/ui/ui-controller"
import { theme } from "@/ui/terminal/theme"

test.each([40, 80])("scrolls complete full-width colored queue cards at %i columns without painting over siblings", async (width) => {
  const messages: IUserMessage[] = Array.from({ length: 4 }, (_, index) => ({
    id: `queued-${index}`,
    sessionId: "default",
    runId: "run",
    role: "user",
    source: index === 0 ? "steer" : "followUp",
    content: [
      `Message ${index} zażółć 🐍 日本語 ${"wrapped text ".repeat(12)}`,
      ...Array.from({ length: 8 }, (_, row) => `message-${index}-row-${row}`),
    ].join("\n"),
    createdAt: index,
  }))
  let updateQueue!: (messages: IUserMessage[]) => void
  function Fixture() {
    const [queue, setQueue] = useState(messages)
    updateQueue = setQueue
    return <box height="100%" flexDirection="column">
      <text height={1} flexShrink={0}>Fixed header</text>
      <QueuedMessages steering={queue.slice(0, 1)} followUps={queue.slice(1)} />
      <text id="queue-footer" height={1} flexShrink={0}>Protected footer</text>
    </box>
  }
  const setup = await testRender(<Fixture />, { width, height: 24 })
  const render = async () => {
    for (let frame = 0; frame < 4; frame++) {
      await act(async () => { await setup.renderOnce() })
    }
  }
  try {
    await render()
    const scroll = setup.renderer.root.findDescendantById("queued-messages-scroll") as ScrollBoxRenderable
    const hint = setup.renderer.root.findDescendantById("queued-messages-hint")!
    const footer = setup.renderer.root.findDescendantById("queue-footer")!
    expect(scroll).toBeInstanceOf(ScrollBoxRenderable)
    expect(scroll.height).toBe(8)
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.height)
    expect(scroll.y + scroll.height).toBeLessThanOrEqual(hint.y)
    expect(hint.y + hint.height).toBeLessThanOrEqual(footer.y)
    for (const [index, message] of messages.entries()) {
      const card = setup.renderer.root.findDescendantById(`queued-message-${message.id}`) as BoxRenderable
      expect(card.width).toBe(scroll.viewport.width)
      expect(card.x).toBe(scroll.viewport.x)
      expect(card.title).toBe(index === 0 ? "Steering" : "Follow-up")
      expect(card.borderColor.equals(RGBA.fromHex(index === 0 ? theme.amber : theme.green))).toBe(true)
      const text = card.getChildren()[0] as TextRenderable
      expect(text.plainText).toBe(message.content)
      expect(text.wrapMode).toBe("word")
      expect(text.truncate).toBe(false)
    }

    const visibleRows: string[] = []
    for (let row = 0; row <= scroll.scrollHeight; row++) {
      act(() => scroll.scrollTo(row))
      await act(async () => { await setup.renderOnce() })
      const lines = setup.captureCharFrame().split("\n")
      expect(lines[0]!.trim()).toBe("Fixed header")
      expect(lines[hint.y]!.trim()).toBe("Esc restores queued input")
      expect(lines[footer.y]!.trim()).toBe("Protected footer")
      expect(lines.slice(footer.y + 1).every((line) => line.trim() === "")).toBe(true)
      visibleRows.push(...lines.slice(scroll.y, scroll.y + scroll.height))
    }
    const allVisible = visibleRows.join("\n")
    for (let index = 0; index < messages.length; index++) {
      for (let row = 0; row < 8; row++) expect(allVisible).toContain(`message-${index}-row-${row}`)
    }
    expect(allVisible).toContain("Steering")
    expect(allVisible).toContain("Follow-up")

    act(() => updateQueue([]))
    await render()
    expect(setup.renderer.root.findDescendantById("queued-messages")).toBeUndefined()
    expect(setup.captureCharFrame()).not.toContain("Esc restores")
    act(() => updateQueue([{ ...messages[1]!, content: "Short queued input" }]))
    await render()
    expect(setup.captureCharFrame()).toContain("Short queued input")
    expect(setup.renderer.root.findDescendantById("queued-messages-scroll")!.height).toBe(3)
  } finally {
    act(() => setup.renderer.destroy())
  }
})

test("recovers a queue viewport through zero and one available row", async () => {
  const message: IUserMessage = {
    id: "recovering-queue", sessionId: "default", runId: "run", role: "user",
    source: "steer", content: "Queued input", createdAt: 1,
  }
  const setup = await testRender(<box height="100%" flexDirection="column">
    <text height={10} flexShrink={0}>Fixed header</text>
    <QueuedMessages steering={[message]} followUps={[]} />
    <text id="recovery-footer" height={1} flexShrink={0}>Protected footer</text>
  </box>, { width: 40, height: 11 })
  try {
    for (const height of [11, 12, 13, 15, 12, 11, 12, 15]) {
      act(() => setup.resize(40, height))
      for (let frame = 0; frame < 4; frame++) {
        await act(async () => { await setup.renderOnce() })
        const footer = setup.renderer.root.findDescendantById("recovery-footer")!
        expect(footer.y + footer.height).toBeLessThanOrEqual(height)
        expect(setup.captureCharFrame().split("\n")[footer.y]!.trim()).toBe("Protected footer")
      }
      const content = setup.captureCharFrame()
      if (height > 11) expect(content).toContain("Esc restores queued input")
      if (height === 15) expect(content).toContain("Queued input")
      if (height === 11) expect(content).not.toContain("Esc restores queued input")
    }
  } finally {
    act(() => setup.renderer.destroy())
  }
})

test("status leaves errors to the dedicated notice",  async () => {
  const setup = await testRender(
    <ChatStatus
      isRunning={false}
      isCompacting={false}
      contextUsage={undefined}
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
    expect(frame).not.toContain("Critical")
    expect(frame).toContain("provider")
    expect(frame).not.toContain("failure")
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("keeps context usage but suppresses stale session errors during compaction", async () => {
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
    expect(frame).toContain("ctx ~142k/200k (71%)")
    expect(frame).not.toContain("compact")
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
    expected: "ctx ~70k/200k (35%)",
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
    expected: "ctx ~80k/200k (40%)",
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
    expected: "ctx ~160k/200k (80%)",
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
    expected: "ctx ~0/200k (0%)",
  },
  {
    name: "an unknown context window",
    usage: {
      estimatedInputTokens: 1_234,
      compactionInputTokens: 2_468,
      shouldCompact: false,
    },
    expected: "ctx ~1.2k",
  },
  {
    name: "zero input with an unknown context window",
    usage: {
      estimatedInputTokens: 0,
      compactionInputTokens: 0,
      shouldCompact: false,
    },
    expected: "ctx ~0",
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
    expected: "ctx ~220k/200k (110%)",
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
    expected: "ctx ~400k/1.0m (40%)",
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
    expected: "ctx ~5.0m/10m (50%)",
  },
] satisfies { name: string; usage: IContextUsage; expected: string }[])(
  "renders only the full-window context estimate for $name",
  async ({ usage, expected }) => {
    const setup = await testRender(
      <ChatStatus
        isRunning={false}
        isCompacting={false}
        contextUsage={usage}
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

      expect(setup.captureCharFrame().trim()).toBe(`[ Model : medium ] | ${expected}`)
      const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
      expect(spans.find((span) => span.text.includes("ctx ~"))?.fg.equals(
        RGBA.fromHex(theme.textMuted),
      )).toBe(true)
      expect(setup.captureCharFrame().match(/ctx ~/g)).toHaveLength(1)
      expect(setup.captureCharFrame()).not.toContain("compact")

      await act(async () => {
        setup.resize(40, 4)
        await setup.renderOnce()
      })

      const narrowFrame = setup.captureCharFrame()
      expect(narrowFrame).toContain("[ Model : medium ]")
      expect(narrowFrame.split("\n").map((line) => line.trim()).join(" "))
        .toContain(expected)
      expect(narrowFrame).not.toMatch(/NaN|Infinity|undefined/)
      expect(narrowFrame.split("\n").every((line) => line.length <= 40)).toBe(true)
      expect(narrowFrame.match(/ctx ~/g)).toHaveLength(1)
      expect(narrowFrame).not.toContain("compact")
    } finally {
      act(() => {
        setup.renderer.destroy()
      })
    }
  },
)

test.each([40, 80])("keeps the active Astra context estimate readable at %i columns", async (width) => {
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
    lastRunReason={undefined}
    errorMessage={undefined}
    inputError={null}
    selectedModelName="GPT-6 Astra Fast"
    reasoningEffort="high"
  />, { width, height: 12 })
  try {
    await act(async () => { await setup.renderOnce() })
    const frame = setup.captureCharFrame().split("\n").map((line) => line.trim()).join(" ")
    expect(frame).toContain("[ GPT-6 Astra Fast : high ]")
    expect(frame).toContain("ctx ~80k/200k (40%)")
    expect(frame.match(/ctx ~/g)).toHaveLength(1)
    expect(frame).not.toContain("compact")
  } finally {
    act(() => setup.renderer.destroy())
  }
})

test("recovers menu rows through notices, reopening and resizing in every frame", async () => {
  const items = Array.from({ length: 5 }, (_, index) => ({ id: `${index}`, label: `item-${index}` }))
  const selectedMenu: TBuliMenuSnapshot = { mode: "commands", items, selectedIndex: 4, errorMessage: null }
  let update!: (menu: TBuliMenuSnapshot | null) => void
  function Fixture() {
    const [menu, setMenu] = useState<TBuliMenuSnapshot | null>(null)
    update = setMenu
    return <box height="100%" flexDirection="column">
      <InputMenu menu={menu} />
      <text height={11} flexShrink={0}>Protected footer</text>
    </box>
  }
  const setup = await testRender(<Fixture />, { width: 60, height: 12 })
  const render = async (expected: string | null, menuRows = 1) => {
    for (let frame = 0; frame < 4; frame++) {
      await act(async () => { await setup.renderOnce() })
      const lines = setup.captureCharFrame().split("\n")
      if (expected !== null) expect(lines.slice(0, menuRows).map((line) => line.trim())).toContain(expected)
      expect(lines[menuRows]!.trim()).toBe("Protected footer")
    }
  }
  try {
    await render(null, 0)
    act(() => update(selectedMenu))
    await render("→ item-4")
    act(() => update({ ...selectedMenu, errorMessage: "Menu error" }))
    act(() => setup.resize(60, 14))
    await act(async () => { await setup.renderOnce() })
    expect(setup.captureCharFrame()).toContain("│ Menu error")
    act(() => setup.resize(60, 12))
    act(() => update(selectedMenu))
    await render("→ item-4")
    expect(setup.captureCharFrame()).not.toContain("Menu error")
    act(() => update(null))
    await render(null, 0)
    act(() => update(selectedMenu))
    await render("→ item-4")
    for (const emptyMessage of ["Searching paths...", "No matching paths"]) {
      act(() => update({ ...selectedMenu, items: [], selectedIndex: 0, emptyMessage }))
      await render(emptyMessage)
    }
    act(() => update(selectedMenu))
    await render("→ item-4")
    for (const height of [14, 11, 12, 16, 12]) {
      act(() => setup.resize(60, height))
      const availableRows = height - 11
      await render(availableRows > 0 ? "→ item-4" : null, Math.min(items.length, availableRows))
    }
  } finally {
    act(() => setup.renderer.destroy())
  }
})

test("keeps the selected command and wrapped menu error visible on a short terminal", async () => {
  const setup = await testRender(
    <box width="100%" height="100%" flexDirection="column">
      <InputMenu
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
      <box id="protected-footer" height={5} flexShrink={0}>
        <text>Editor and status</text>
      </box>
    </box>,
    { width: 40, height: 14 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()
    })
    await act(async () => { await setup.renderOnce() })
    await act(async () => { await setup.renderOnce() })

    const frame = setup.captureCharFrame()
    expect(frame).toContain("→ command-9")
    expect(frame).not.toContain("command-0")
    expect(frame).toContain("Could not refresh model catalog.")
    expect(frame).toContain("available.")
    expect(frame).toContain("Editor and status")
    const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
    for (const [text, color] of [
      ["→ command-9", theme.green],
      ["command-8", theme.amber],
      ["a narrow terminal", theme.textMuted],
    ]) {
      expect(spans.some((span) => span.text.includes(text!) && span.fg.equals(
        RGBA.fromHex(color!),
      ))).toBe(true)
    }
    const menu = setup.renderer.root.findDescendantById("command-menu")!
    const footer = setup.renderer.root.findDescendantById("protected-footer")!
    expect(menu.y + menu.height).toBeLessThanOrEqual(footer.y)
    expect(footer.y + footer.height).toBeLessThanOrEqual(14)
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})
