import {
    BoxRenderable,
    CodeRenderable,
    DiffRenderable,
    ScrollBoxRenderable,
    TextRenderable,
    type Renderable,
} from "@opentui/core"
import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { expect, spyOn, test } from "bun:test"

import { MeasuredTranscriptBox } from "@/ui/sessions/MeasuredTranscriptBox"
import { copyOpenTuiSelectionToClipboard } from "@/ui/terminal/clipboard/copy-selection"
import { syntax, theme } from "@/ui/terminal/theme"

const WIDE_WIDTH = 100
const NARROW_WIDTH = 36
const TERMINAL_HEIGHT = 30
const HISTORY_LENGTH = 40
const DIFF_LINE_COUNT = 100
const TRANSITION_FRAMES = 6
const MAX_SETTLING_FRAMES = 60
const REQUIRED_QUIET_FRAMES = 3
const TEST_TIMEOUT_MS = 30_000
const SELECTION_START = { x: 10, y: 1 }
const SELECTION_END = { x: 25, y: 3 }
const UNICODE_TEXT = "zażółć 🐍 日本語 abcdefghijklmnopqrstuvwxyz words wrapping on a narrow screen"

type TestSetup = Awaited<ReturnType<typeof createTestRenderer>>

function codeRenderables(root: Renderable): CodeRenderable[] {
    return root.getChildren().flatMap((child) => [
        ...(child instanceof CodeRenderable ? [child] : []),
        ...codeRenderables(child),
    ])
}

function unicodeDiff(lineCount: number): string {
    return [
        "--- a/example.ts",
        "+++ b/example.ts",
        `@@ -1,${lineCount} +1,${lineCount} @@`,
        ...Array.from({ length: lineCount }, (_, index) => [
            `-const value${index} = "${UNICODE_TEXT}";`,
            `+const value${index} = "${UNICODE_TEXT} changed";`,
        ]).flat(),
        "",
    ].join("\n")
}

async function prepareFrame(setup: TestSetup): Promise<void> {
    await Promise.all(codeRenderables(setup.renderer.root).map((code) => code.highlightingDone))
    const previousFrame = setup.renderer.frameId
    await setup.renderOnce()
    expect(setup.renderer.frameId).toBe(previousFrame + 1)
}

function capture(setup: TestSetup, scrollbox: ScrollBoxRenderable) {
    return {
        characters: setup.captureCharFrame(),
        spans: setup.captureSpans(),
        top: scrollbox.scrollTop,
        historyHeight: scrollbox.scrollHeight,
        viewport: {
            x: scrollbox.viewport.screenX,
            y: scrollbox.viewport.screenY,
            width: scrollbox.viewport.width,
            height: scrollbox.viewport.height,
        },
        code: codeRenderables(scrollbox).map((code) => ({
            width: code.width,
            height: code.height,
            lines: code.virtualLineCount,
            text: code.plainText,
        })),
        selection: setup.renderer.getSelection()?.getSelectedText() ?? null,
    }
}

async function settle(setup: TestSetup, scrollbox: ScrollBoxRenderable): Promise<void> {
    let previousSignature: string | undefined
    let quietFrames = 0
    for (let frame = 0; frame < MAX_SETTLING_FRAMES; frame += 1) {
        await prepareFrame(setup)
        const signature = JSON.stringify(capture(setup, scrollbox))
        quietFrames = signature === previousSignature ? quietFrames + 1 : 0
        if (quietFrames >= REQUIRED_QUIET_FRAMES) return
        previousSignature = signature
    }
    throw new Error("Transcript layout did not settle within the bounded frame limit")
}

async function createFixture(Box: typeof BoxRenderable) {
    const setup = await createTestRenderer({
        width: WIDE_WIDTH,
        height: TERMINAL_HEIGHT,
        clock: new ManualClock(),
    })
    const scrollbox = new ScrollBoxRenderable(setup.renderer, {
        width: "100%",
        height: "100%",
        scrollY: true,
        stickyScroll: true,
        stickyStart: "bottom",
        viewportCulling: true,
        verticalScrollbarOptions: { width: 1, showArrows: false },
    })
    const transcript = new Box(setup.renderer, { width: "100%", flexDirection: "column" })
    const diff = new DiffRenderable(setup.renderer, {
        diff: unicodeDiff(DIFF_LINE_COUNT),
        filetype: "typescript",
        syntaxStyle: syntax,
        fg: theme.text,
        width: "100%",
        view: "unified",
        wrapMode: "word",
        showLineNumbers: true,
    })
    transcript.add(diff)
    const messages = Array.from({ length: HISTORY_LENGTH }, (_, index) => {
        const card = new BoxRenderable(setup.renderer, { width: "100%", flexDirection: "column" })
        const text = new TextRenderable(setup.renderer, {
            content: `Message ${index}: ${UNICODE_TEXT}`,
            wrapMode: "word",
        })
        card.add(text)
        transcript.add(card)
        return text
    })
    scrollbox.add(transcript)
    setup.renderer.root.add(scrollbox)
    return { setup, scrollbox, transcript, diff, messages }
}

function expectSameChildren(parent: Renderable, expected: readonly Renderable[]): void {
    const children = parent.getChildren()
    expect(children).toHaveLength(expected.length)
    expected.forEach((child, index) => expect(children[index]).toBe(child))
}

function destroy(setup: TestSetup): void {
    setup.renderer.destroy()
    expect(setup.renderer.getLifecyclePasses().size).toBe(0)
}

test("culls hidden message interiors only while layout is stable and retains their identity", async () => {
    const { setup, scrollbox, transcript, messages } = await createFixture(MeasuredTranscriptBox)
    const hidden = messages[0]
    const visible = messages.at(-2)
    const belowViewport = messages.at(-1)
    if (!hidden || !visible || !belowViewport) {
        destroy(setup)
        throw new Error("Expected hidden, visible and viewport-edge history messages")
    }
    const hiddenUpdates = spyOn(hidden, "updateLayout")
    const visibleUpdates = spyOn(visible, "updateLayout")
    const belowViewportUpdates = spyOn(belowViewport, "updateLayout")
    try {
        await settle(setup, scrollbox)
        const children = transcript.getChildren()
        expect(children).toHaveLength(HISTORY_LENGTH + 1)
        expect(hidden.screenY + hidden.height).toBeLessThan(scrollbox.viewport.screenY)
        hiddenUpdates.mockClear()
        visibleUpdates.mockClear()
        belowViewportUpdates.mockClear()

        scrollbox.scrollBy(-1)
        await prepareFrame(setup)
        expect(hiddenUpdates).not.toHaveBeenCalled()
        expect(visibleUpdates).toHaveBeenCalled()
        expect(visible.screenY).toBeLessThan(scrollbox.viewport.screenY + scrollbox.viewport.height)
        expect(visible.screenY + visible.height).toBeGreaterThan(scrollbox.viewport.screenY)
        expect(belowViewport.screenY).toBe(scrollbox.viewport.screenY + scrollbox.viewport.height)
        expect(belowViewportUpdates).not.toHaveBeenCalled()
        expectSameChildren(transcript, children)

        hidden.content = UNICODE_TEXT.repeat(HISTORY_LENGTH)
        await prepareFrame(setup)
        expect(hiddenUpdates).toHaveBeenCalled()
        await settle(setup, scrollbox)
        expectSameChildren(transcript, children)
    } finally {
        hiddenUpdates.mockRestore()
        visibleUpdates.mockRestore()
        belowViewportUpdates.mockRestore()
        destroy(setup)
    }
})

test("falls back to a normal box outside a scrollbox", async () => {
    const setup = await createTestRenderer({
        width: WIDE_WIDTH,
        height: TERMINAL_HEIGHT,
        clock: new ManualClock(),
    })
    const transcript = new MeasuredTranscriptBox(setup.renderer, {
        width: "100%",
        flexDirection: "column",
    })
    const text = new TextRenderable(setup.renderer, { content: UNICODE_TEXT })
    transcript.add(text)
    setup.renderer.root.add(transcript)
    const updates = spyOn(text, "updateLayout")
    try {
        await prepareFrame(setup)
        updates.mockClear()
        transcript.y = TERMINAL_HEIGHT
        await prepareFrame(setup)
        expect(updates).toHaveBeenCalled()
        expect(text.screenY).toBe(TERMINAL_HEIGHT)
    } finally {
        updates.mockRestore()
        destroy(setup)
    }
})

async function layoutTrace(Box: typeof BoxRenderable) {
    const { setup, scrollbox, transcript, diff, messages } = await createFixture(Box)
    const captures: { label: string; frame: ReturnType<typeof capture> }[] = []
    const transition = async (label: string, update: () => void | Promise<void>) => {
        await update()
        for (let frame = 0; frame < TRANSITION_FRAMES; frame += 1) {
            await prepareFrame(setup)
            captures.push({ label: `${label}-${frame}`, frame: capture(setup, scrollbox) })
        }
        await settle(setup, scrollbox)
        captures.push({ label: `${label}-settled`, frame: capture(setup, scrollbox) })
    }
    const resize = (width: number) => setup.resize(width, TERMINAL_HEIGHT)
    const scrollToBottom = () => scrollbox.scrollTo(scrollbox.scrollHeight)
    try {
        await settle(setup, scrollbox)
        const initial = capture(setup, scrollbox)
        expect(diff.screenY + diff.height).toBeLessThanOrEqual(scrollbox.viewport.screenY)
        await transition("narrow-hidden-diff", () => resize(NARROW_WIDTH))
        await transition("wide-hidden-diff", () => resize(WIDE_WIDTH))
        expect(capture(setup, scrollbox)).toEqual(initial)

        const hiddenMessage = messages[0]
        if (!hiddenMessage) throw new Error("Expected an offscreen history message")
        await transition("hidden-content-growth", () => {
            hiddenMessage.content = UNICODE_TEXT.repeat(HISTORY_LENGTH)
            diff.diff = unicodeDiff(DIFF_LINE_COUNT + HISTORY_LENGTH)
        })
        await transition("first-visit", () => scrollbox.scrollTo(0))
        await transition("detached-narrow", () => resize(NARROW_WIDTH))
        await transition("detached-wide", () => resize(WIDE_WIDTH))

        await setup.mockMouse.pressDown(SELECTION_START.x, SELECTION_START.y)
        await setup.mockMouse.moveTo(SELECTION_END.x, SELECTION_END.y)
        expect(setup.renderer.getSelection()?.getSelectedText().length).toBeGreaterThan(0)
        await transition("active-selection-scroll", () => scrollbox.scrollBy(1))
        await transition("active-selection-narrow", () => resize(NARROW_WIDTH))
        await transition("active-selection-wide", () => resize(WIDE_WIDTH))
        await setup.mockMouse.release(SELECTION_END.x, SELECTION_END.y)
        const selection = setup.renderer.getSelection()
        if (!selection) throw new Error("Expected selection after scrolling and resizing")
        const selectedText = selection.getSelectedText()
        expect(selectedText.length).toBeGreaterThan(0)
        const copiedTexts: string[] = []
        const didCopy = await copyOpenTuiSelectionToClipboard({
            renderer: setup.renderer,
            selection,
            clipboard: {
                writeText: async (text) => {
                    copiedTexts.push(text)
                    return {
                        host: { status: "written" },
                        terminal: { status: "attempted", capability: "supported" },
                    }
                },
            },
        })
        expect(didCopy).toBe(true)
        expect(copiedTexts).toEqual([selectedText])
        expect(setup.renderer.getSelection()).toBeNull()

        await transition("bottom", scrollToBottom)
        const insertedCard = new BoxRenderable(setup.renderer, { width: "100%" })
        insertedCard.add(new TextRenderable(setup.renderer, {
            content: UNICODE_TEXT.repeat(HISTORY_LENGTH),
            wrapMode: "word",
        }))
        await transition("insert-hidden-card", () => { transcript.add(insertedCard, 0) })
        await transition("visit-inserted-card", () => scrollbox.scrollTo(0))
        await transition("remove-hidden-diff", () => {
            scrollToBottom()
            transcript.remove(diff)
            diff.destroyRecursively()
        })
        return { captures, copiedTexts }
    } finally {
        destroy(setup)
    }
}

test("matches ordinary box frames, colors, geometry and selection through offscreen changes", async () => {
    const reference = await layoutTrace(BoxRenderable)
    const optimized = await layoutTrace(MeasuredTranscriptBox)
    expect(optimized).toEqual(reference)
}, TEST_TIMEOUT_MS)
