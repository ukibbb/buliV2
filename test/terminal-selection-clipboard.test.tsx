import { expect, test } from "bun:test"
import type { ClipboardWriteResult, Selection } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"

import { TerminalSelectionClipboardRoot } from "@/terminal/clipboard/ClipboardOverlay"
import { SelectionClipboardBridge } from "@/terminal/clipboard/SelectionClipboardBridge"
import { copyOpenTuiSelectionToClipboard } from "@/terminal/clipboard/copy-selection"

function selectionWithText(
  text: string,
): Pick<Selection, "getSelectedText"> {
  return { getSelectedText: () => text }
}

function successfulWriteResult(): ClipboardWriteResult {
  return {
    host: { status: "written" },
    terminal: { status: "attempted", capability: "supported" },
  }
}

test("copies selected text and clears the selection before the write finishes", async () => {
  const write = Promise.withResolvers<ClipboardWriteResult>()
  const writes: Array<{ text: string; destination: string }> = []
  let clearSelectionCount = 0

  const copyTask = copyOpenTuiSelectionToClipboard({
    clipboard: {
      writeText: (text, options) => {
        writes.push({ text, destination: options.destination })
        return write.promise
      },
    },
    renderer: {
      clearSelection: () => {
        clearSelectionCount += 1
      },
    },
    selection: selectionWithText("selected assistant text"),
  })

  expect(writes).toEqual([{
    text: "selected assistant text",
    destination: "all-available",
  }])
  expect(clearSelectionCount).toBe(1)

  write.resolve(successfulWriteResult())
  expect(await copyTask).toBe(true)
})

test("ignores empty selection text", async () => {
  let writeCount = 0
  let clearSelectionCount = 0

  const didCopy = await copyOpenTuiSelectionToClipboard({
    clipboard: {
      writeText: async () => {
        writeCount += 1
        return successfulWriteResult()
      },
    },
    renderer: {
      clearSelection: () => {
        clearSelectionCount += 1
      },
    },
    selection: selectionWithText(""),
  })

  expect(didCopy).toBe(false)
  expect(writeCount).toBe(0)
  expect(clearSelectionCount).toBe(0)
})

test("reports clipboard failures after clearing the selection", async () => {
  const clipboardError = new Error("clipboard unavailable")
  const reportedErrors: unknown[] = []
  let clearSelectionCount = 0

  const didCopy = await copyOpenTuiSelectionToClipboard({
    clipboard: {
      writeText: async () => {
        throw clipboardError
      },
    },
    renderer: {
      clearSelection: () => {
        clearSelectionCount += 1
      },
    },
    selection: selectionWithText("selected text"),
    onClipboardWriteError: (error) => {
      reportedErrors.push(error)
    },
  })

  expect(didCopy).toBe(false)
  expect(clearSelectionCount).toBe(1)
  expect(reportedErrors).toEqual([clipboardError])
})

test("reports a failed clipboard result without showing success", async () => {
  const clipboardError = new Error("host clipboard failed")
  const reportedErrors: unknown[] = []

  const didCopy = await copyOpenTuiSelectionToClipboard({
    clipboard: {
      writeText: async () => ({
        host: { status: "failed", error: clipboardError },
        terminal: { status: "local-failure", capability: "supported" },
      }),
    },
    renderer: { clearSelection: () => {} },
    selection: selectionWithText("selected text"),
    onClipboardWriteError: (error) => {
      reportedErrors.push(error)
    },
  })

  expect(didCopy).toBe(false)
  expect(reportedErrors).toEqual([clipboardError])
})

test("copies a mouse selection and clears it after capture", async () => {
  const copiedTexts: string[] = []
  let completedCopyCount = 0
  const setup = await testRender(
    <>
      <SelectionClipboardBridge
        clipboard={{
          writeText: async (text) => {
            copiedTexts.push(text)
            return successfulWriteResult()
          },
        }}
        onCopyComplete={() => {
          completedCopyCount += 1
        }}
      />
      <text selectable>selected terminal text</text>
    </>,
    { width: 80, height: 8 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()
      await setup.mockMouse.drag(0, 0, 21, 0)
      await Promise.resolve()
    })
    await setup.renderOnce()

    expect(copiedTexts).toEqual(["selected terminal text"])
    expect(completedCopyCount).toBe(1)
    expect(setup.renderer.getSelection()).toBeNull()
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("copies double- and triple-click selections without resetting click state", async () => {
  const copiedTexts: string[] = []
  let completedCopyCount = 0
  const setup = await testRender(
    <>
      <SelectionClipboardBridge
        clipboard={{
          writeText: async (text) => {
            copiedTexts.push(text)
            return successfulWriteResult()
          },
        }}
        onCopyComplete={() => {
          completedCopyCount += 1
        }}
      />
      <text selectable>alpha beta gamma</text>
    </>,
    { width: 80, height: 8 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()
      await setup.mockMouse.click(6, 0)
      await setup.mockMouse.click(6, 0)
      await setup.mockMouse.click(6, 0)
    })
    await setup.waitFor(() => copiedTexts.length === 2)

    expect(copiedTexts).toEqual(["beta", "alpha beta gamma"])
    expect(completedCopyCount).toBe(2)
    expect(setup.renderer.getSelection()).toBeNull()
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("keeps a newer mouse drag alive past the word clear delay", async () => {
  const copiedTexts: string[] = []
  const setup = await testRender(
    <>
      <SelectionClipboardBridge
        clipboard={{
          writeText: async (text) => {
            copiedTexts.push(text)
            return successfulWriteResult()
          },
        }}
        onCopyComplete={() => {}}
      />
      <text selectable>alpha beta gamma</text>
    </>,
    { width: 80, height: 8 },
  )

  try {
    await act(async () => {
      await setup.renderOnce()
      await setup.mockMouse.click(6, 0)
      await setup.mockMouse.click(6, 0)
    })
    await setup.waitFor(() => copiedTexts.length === 1)
    expect(copiedTexts).toEqual(["beta"])

    await act(async () => {
      await setup.mockMouse.pressDown(6, 0)
      await setup.mockMouse.moveTo(12, 0)
    })
    const newerSelection = setup.renderer.getSelection()
    expect(newerSelection?.behavior).toBe("line")
    expect(newerSelection?.getSelectedText()).toBe("alpha beta gamma")

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 550))
    })
    expect(setup.renderer.getSelection()).toBe(newerSelection)

    await act(async () => {
      await setup.mockMouse.release(12, 0)
    })
    await setup.waitFor(() => copiedTexts.length === 2)
    expect(copiedTexts).toEqual(["beta", "alpha beta gamma"])
    expect(setup.renderer.getSelection()).toBeNull()
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("serializes selection writes so the newest text finishes last", async () => {
  const writes: Array<{
    readonly text: string
    readonly completion: PromiseWithResolvers<ClipboardWriteResult>
  }> = []
  let completedCopyCount = 0
  const setup = await testRender(
    <SelectionClipboardBridge
      clipboard={{
        writeText: (text) => {
          const completion = Promise.withResolvers<ClipboardWriteResult>()
          writes.push({ text, completion })
          return completion.promise
        },
      }}
      onCopyComplete={() => {
        completedCopyCount += 1
      }}
    />,
    { width: 80, height: 8 },
  )

  try {
    await act(async () => {
      setup.renderer.emit("selection", selectionWithText("first") as Selection)
      setup.renderer.emit("selection", selectionWithText("second") as Selection)
      await Promise.resolve()
    })
    expect(writes.map(({ text }) => text)).toEqual(["first"])

    await act(async () => {
      writes[0]?.completion.resolve(successfulWriteResult())
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(writes.map(({ text }) => text)).toEqual(["first", "second"])

    await act(async () => {
      writes[1]?.completion.resolve(successfulWriteResult())
      await Promise.resolve()
    })
    expect(completedCopyCount).toBe(2)
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})

test("resets and hides the clipboard confirmation toast", async () => {
  const setup = await testRender(
    <TerminalSelectionClipboardRoot
      clipboard={{ writeText: async () => successfulWriteResult() }}
      copyConfirmationToastDurationMs={60}
    >
      <text>Terminal content</text>
    </TerminalSelectionClipboardRoot>,
    { width: 80, height: 8 },
  )

  try {
    await act(async () => {
      setup.renderer.emit(
        "selection",
        selectionWithText("first selection") as Selection,
      )
      await Promise.resolve()
    })
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("Copied to clipboard")

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 35))
      setup.renderer.emit(
        "selection",
        selectionWithText("second selection") as Selection,
      )
      await Promise.resolve()
    })
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("Copied to clipboard")

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 35))
    })
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("Copied to clipboard")

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 35))
    })
    await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toContain("Copied to clipboard")
  } finally {
    act(() => {
      setup.renderer.destroy()
    })
  }
})
