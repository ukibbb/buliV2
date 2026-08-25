import {
  type ClipboardReadResult,
  type ClipboardService,
  type Renderable,
  TextareaRenderable,
} from "@opentui/core"
import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act, useRef, useState } from "react"

import { PromptEditor } from "@/app/ui/chat/PromptEditor"
import type { IPathCompletion } from "@/app/ui/controller/path-menu"
import type { IUserInput } from "@/agent"

test("selected path completion becomes a structured reference", async () => {
  const submitted: IUserInput[] = []
  const path = "/workspace/src/main.ts"
  const setup = await testRender(
    <PromptHarness
      completion={{
        triggerStart: 7,
        triggerEnd: 10,
        value: "@src/main.ts",
        reference: { type: "path", kind: "file", path },
      }}
      onSubmit={(input) => submitted.push(structuredClone(input))}
    />,
    { width: 80, height: 10 },
  )

  try {
    await act(async () => {
      await setup.mockInput.typeText("Review @ma")
      setup.mockInput.pressEnter()
      await Bun.sleep(0)
      await setup.renderOnce()
    })
    expect(setup.captureCharFrame()).toContain("Review @src/main.ts")

    await act(async () => {
      setup.mockInput.pressEnter()
      await Bun.sleep(0)
    })
    expect(submitted).toEqual([{
      text: "Review @src/main.ts ",
      references: [{
        type: "path",
        kind: "file",
        path,
        source: { value: "@src/main.ts", start: 7, end: 19 },
      }],
    }])
  } finally {
    act(() => setup.renderer.destroy())
  }
})

test("selected path source uses terminal offsets after wide text", async () => {
  const submitted: IUserInput[] = []
  const setup = await testRender(
    <PromptHarness
      completion={{
        triggerStart: 3,
        triggerEnd: 6,
        value: "@src/main.ts",
        reference: {
          type: "path",
          kind: "file",
          path: "/workspace/src/main.ts",
        },
      }}
      onSubmit={(input) => submitted.push(structuredClone(input))}
    />,
    { width: 80, height: 10 },
  )
  try {
    await act(async () => {
      await setup.mockInput.typeText("🙂 @ma")
      expect(findTextarea(setup.renderer.root).cursorOffset).toBe(6)
      setup.mockInput.pressEnter()
      await Bun.sleep(0)
      await setup.renderOnce()
    })
    expect(setup.captureCharFrame()).toContain("@src/main.ts")
    await act(async () => {
      setup.mockInput.pressEnter()
      await Bun.sleep(0)
    })
    expect(submitted[0]?.references?.[0]?.source).toEqual({
      value: "@src/main.ts",
      start: 3,
      end: 15,
    })
  } finally {
    act(() => setup.renderer.destroy())
  }
})

test("Ctrl+V inserts a validated clipboard image attachment", async () => {
  const submitted: IUserInput[] = []
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlL8AAAAASUVORK5CYII=",
    "base64",
  )
  const setup = await testRender(
    <PromptHarness
      clipboardRead={async (): Promise<ClipboardReadResult> => ({
        status: "read",
        representation: { mimeType: "image/png", bytes: png },
      })}
      onSubmit={(input) => submitted.push(structuredClone(input))}
    />,
    { width: 80, height: 10 },
  )

  try {
    await act(async () => {
      setup.mockInput.pressKey("v", { ctrl: true })
      await Bun.sleep(0)
      await setup.renderOnce()
    })
    expect(setup.captureCharFrame()).toContain("[Image 1]")

    await act(async () => {
      setup.mockInput.pressEnter()
      await Bun.sleep(0)
    })
    expect(submitted).toHaveLength(1)
    expect(submitted[0]).toMatchObject({
      text: "[Image 1] ",
      attachments: [{
        type: "image",
        mimeType: "image/png",
        filename: "clipboard-1.png",
        source: { value: "[Image 1]", start: 0, end: 9 },
      }],
    })
    expect(submitted[0]?.attachments?.[0]?.data).toBe(
      Buffer.from(png).toString("base64"),
    )
  } finally {
    act(() => setup.renderer.destroy())
  }
})

test("submitting cancels a pending clipboard read", async () => {
  const clipboard = Promise.withResolvers<ClipboardReadResult>()
  const setup = await testRender(
    <PromptHarness
      clipboardRead={() => clipboard.promise}
      onSubmit={() => {}}
    />,
    { width: 80, height: 10 },
  )
  try {
    await act(async () => {
      setup.mockInput.pressKey("v", { ctrl: true })
      setup.mockInput.pressEnter()
      clipboard.resolve({
        status: "read",
        representation: {
          mimeType: "image/png",
          bytes: Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlL8AAAAASUVORK5CYII=",
            "base64",
          ),
        },
      })
      await Bun.sleep(0)
      await setup.renderOnce()
    })
    expect(setup.captureCharFrame()).not.toContain("[Image 1]")
  } finally {
    act(() => setup.renderer.destroy())
  }
})

test("undo restores capability metadata with an extmark", async () => {
  const submitted: IUserInput[] = []
  const setup = await testRender(
    <PromptHarness
      completion={{
        triggerStart: 0,
        triggerEnd: 3,
        value: "@src/main.ts",
        reference: {
          type: "path",
          kind: "file",
          path: "/workspace/src/main.ts",
        },
      }}
      onSubmit={(input) => submitted.push(structuredClone(input))}
    />,
    { width: 80, height: 10 },
  )
  try {
    await act(async () => {
      await setup.mockInput.typeText("@ma")
      setup.mockInput.pressEnter()
      await Bun.sleep(0)
    })
    const textarea = findTextarea(setup.renderer.root)
    await act(async () => {
      textarea.setSelection(0, 12)
      textarea.deleteSelection()
      textarea.undo()
      await setup.renderOnce()
      setup.mockInput.pressEnter()
      await Bun.sleep(0)
    })

    expect(submitted[0]?.references).toEqual([{
      type: "path",
      kind: "file",
      path: "/workspace/src/main.ts",
      source: { value: "@src/main.ts", start: 0, end: 12 },
    }])
  } finally {
    act(() => setup.renderer.destroy())
  }
})

test("an extmark ID reused after undo does not reuse an old capability", async () => {
  const drafts: IUserInput[] = []
  const setup = await testRender(
    <PromptHarness
      keepMenuOpen
      completion={[{
        triggerStart: 0,
        triggerEnd: 3,
        value: "@same",
        reference: {
          type: "path",
          kind: "file",
          path: "/workspace/old.ts",
        },
      }, {
        triggerStart: 0,
        triggerEnd: 3,
        value: "@same",
        reference: {
          type: "path",
          kind: "file",
          path: "/workspace/new.ts",
        },
      }]}
      onValueChange={(input) => drafts.push(structuredClone(input))}
      onSubmit={() => {}}
    />,
    { width: 80, height: 10 },
  )
  try {
    await act(async () => {
      await setup.mockInput.typeText("@sa")
      setup.mockInput.pressEnter()
      await Bun.sleep(0)
    })
    const textarea = findTextarea(setup.renderer.root)
    await act(async () => {
      textarea.undo()
      textarea.undo()
      await setup.renderOnce()
      expect(textarea.plainText).toBe("")
      await setup.mockInput.typeText("@sa")
      await setup.renderOnce()
      setup.mockInput.pressEnter()
      await Bun.sleep(0)
      await setup.renderOnce()
      expect(textarea.plainText).toBe("@same ")
    })

    expect(drafts.at(-1)?.references).toEqual([{
      type: "path",
      kind: "file",
      path: "/workspace/new.ts",
      source: { value: "@same", start: 0, end: 5 },
    }])
  } finally {
    act(() => setup.renderer.destroy())
  }
})

function PromptHarness(props: {
  readonly completion?: IPathCompletion | readonly IPathCompletion[]
  readonly keepMenuOpen?: boolean
  readonly clipboardRead?: Pick<ClipboardService, "read">["read"]
  readonly onValueChange?: (input: IUserInput) => void
  readonly onSubmit: (input: IUserInput) => void
}) {
  const valueRef = useRef<IUserInput>({ text: "" })
  const initialValueRef = useRef<IUserInput>({ text: "" })
  const [menuOpen, setMenuOpen] = useState(props.completion !== undefined)
  const completionIndexRef = useRef(0)
  const completions = props.completion === undefined
    ? []
    : Array.isArray(props.completion) ? props.completion : [props.completion]
  return (
    <PromptEditor
      value={initialValueRef.current}
      blocked={false}
      menuOpen={
        props.keepMenuOpen && completionIndexRef.current < completions.length
          ? true
          : menuOpen
      }
      {...(props.clipboardRead
        ? { clipboard: { read: props.clipboardRead } }
        : {})}
      getCurrentValue={() => valueRef.current}
      onValueChange={(value, mention) => {
        valueRef.current = value
        props.onValueChange?.(value)
        if (mention && completionIndexRef.current < completions.length) {
          setMenuOpen(true)
        }
      }}
      onSubmit={async (input) => {
        props.onSubmit(input)
        return "retained"
      }}
      onMoveMenuSelection={() => {}}
      onActivateMenuItem={async () => {
        setMenuOpen(false)
        const completion = completions[completionIndexRef.current]
        completionIndexRef.current += 1
        return completion
      }}
      onError={(error) => {
        throw error
      }}
    />
  )
}

function findTextarea(root: Renderable): TextareaRenderable {
  if (root instanceof TextareaRenderable) return root
  for (const child of root.getChildren()) {
    try {
      return findTextarea(child)
    } catch {
      // Continue through the remaining render tree.
    }
  }
  throw new Error("Expected textarea")
}
