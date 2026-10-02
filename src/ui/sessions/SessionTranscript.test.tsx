import { ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { expect, spyOn, test } from "bun:test"
import { act } from "react"

import type { IAssistantMessage, IUserMessage } from "@/agent"
import type { IBuliApplication } from "@/app/contracts"
import { HISTORY_MESSAGE_TARGET } from "@/sessions/history-contracts"
import { BuliRuntimeProvider } from "@/ui/context/application-context"
import { SessionTranscript } from "@/ui/sessions/SessionTranscript"
import { createSessionTestSource } from "../../../test/fixtures/session-source"

function messages(count: number): IUserMessage[] {
    return Array.from({ length: count }, (_, index) => ({
        id: `message-${index}`, sessionId: "session", runId: "run", role: "user",
        source: "prompt", content: `Message ${index}`, createdAt: index,
    }))
}

async function fixture(count: number) {
    const source = createSessionTestSource({
        activeBranchId: "main", messages: messages(count), isRunning: false, isCompacting: false,
        pendingSteeringMessages: [], pendingFollowUpMessages: [], pendingToolCallIds: [],
    })
    // These renderer fixtures contain only user messages. Tool-group boundaries are tested in SQLite tests.
    const load = spyOn(source.source, "loadHistoryPage").mockImplementation((branchId, cursor) => {
        const all = source.getData().messages
        const end = cursor ? all.findIndex((message) => message.id === cursor.beforeMessageId) : all.length
        const start = Math.max(0, end - HISTORY_MESSAGE_TARGET)
        return { sessionId: "session", branchId, messages: all.slice(start, end),
            ...(start > 0 ? { olderCursor: { sessionId: "session", branchId, beforeMessageId: all[start]!.id } } : {}) }
    })
    const runtime = { openSession: () => source.source } as unknown as IBuliApplication
    let setup!: Awaited<ReturnType<typeof testRender>>
    await act(async () => {
        setup = await testRender(<BuliRuntimeProvider runtime={runtime}>
            <SessionTranscript sessionId="session" />
        </BuliRuntimeProvider>, { width: 80, height: 20 })
    })
    const render = async () => { await act(async () => { await setup.renderOnce(); await setup.renderOnce() }) }
    await render()
    const scroll = setup.renderer.root.findDescendantById("session-transcript") as ScrollBoxRenderable
    const maximum = () => Math.max(0, scroll.scrollHeight - scroll.viewport.height)
    const click = async (id: string) => {
        const target = setup.renderer.root.findDescendantById(id)!
        expect(target).toBeDefined()
        await act(async () => { await setup.mockMouse.click(target.screenX + 1, target.screenY) })
        await render()
    }
    const older = async () => {
        act(() => scroll.scrollTo(0))
        await render()
        await click("history-older")
    }
    return { ...source, setup, load, render, scroll, maximum, click, older,
        dispose: () => { act(() => setup.renderer.destroy()); load.mockRestore() } }
}

test("mouse scrolling keeps streaming and committed messages live without forcing the bottom", async () => {
    const f = await fixture(50)
    const stream: IAssistantMessage = { id: "stream", sessionId: "session", runId: "run",
        role: "assistant", createdAt: 60, stopReason: "pending", content: [{ type: "text", text: "Live start" }] }
    try {
        act(() => f.setData({ ...f.getData(), streamingMessage: stream, isRunning: true }))
        await f.render()
        expect(f.scroll.scrollTop).toBe(f.maximum())
        await act(async () => { await f.setup.mockMouse.scroll(f.scroll.screenX + 1, f.scroll.screenY + 1, "up") })
        await f.render()
        const position = f.scroll.scrollTop
        expect(position).toBeLessThan(f.maximum())
        act(() => f.setData({ ...f.getData(), streamingMessage: {
            ...stream, content: [{ type: "text", text: "Live start\nLive continuation\nStill live" }],
        } }))
        await f.render()
        expect(f.scroll.scrollTop).toBe(position)
        expect(f.setup.captureCharFrame()).not.toContain("Są nowe wiadomości")
        expect(f.setup.renderer.root.findDescendantById("history-latest")).toBeUndefined()
        act(() => f.setData({ ...f.getData(), messages: messages(51) }))
        await f.render()
        expect(f.scroll.scrollTop).toBe(position)
        expect(f.scroll.findDescendantById("user-message-message-50")).toBeDefined()
        act(() => f.scroll.scrollTo(f.maximum()))
        await f.render()
        expect(f.setup.captureCharFrame()).toContain("Still live")
        act(() => f.setData({ ...f.getData(), streamingMessage: {
            ...stream, content: [{ type: "text", text: "Live start\nLive continuation\nStill live\nFollowing again" }],
        } }))
        await f.render()
        expect(f.scroll.scrollTop).toBe(f.maximum())
        expect(f.setup.captureCharFrame()).toContain("Following again")
    } finally { f.dispose() }
})

test("explicit pagination replaces payloads, walks back and returns directly to live content", async () => {
    const f = await fixture(1_600)
    const first = () => f.scroll.content.getChildren().find((child) => child.id !== "history-older")!
    const assertPage = (start: number, count: number) => {
        expect(f.scroll.findDescendantById(`user-message-message-${start}`)).toBeDefined()
        expect(f.scroll.findDescendantById(`user-message-message-${start + count - 1}`)).toBeDefined()
        expect(f.scroll.findDescendantById(`user-message-message-${start + count}`)).toBeUndefined()
        expect(f.scroll.content.getChildren()).toHaveLength(count + (start > 0 ? 1 : 0))
    }
    try {
        assertPage(1_100, 500)
        const discarded = first()
        await f.older()
        assertPage(600, 500)
        expect(discarded.isDestroyed).toBe(true)
        expect(f.scroll.scrollTop).toBe(f.maximum())
        await f.older()
        assertPage(100, 500)
        await f.older()
        assertPage(0, 100)
        const calls = f.load.mock.calls.length
        act(() => f.setData({ ...f.getData(), messages: messages(1_601), streamingMessage: {
            id: "stream", sessionId: "session", runId: "run", role: "assistant", createdAt: 4_000,
            stopReason: "pending", content: [{ type: "text", text: "Streaming while reading archive" }],
        } }))
        await f.render()
        expect(f.load).toHaveBeenCalledTimes(calls)
        assertPage(0, 100)
        await f.click("history-newer")
        assertPage(100, 500)
        await f.click("history-newer")
        assertPage(600, 500)
        await f.click("history-newer")
        expect(f.scroll.findDescendantById("user-message-message-1600")).toBeDefined()
        expect(f.setup.captureCharFrame()).toContain("Streaming while reading archive")
        await f.older()
        await f.older()
        await f.click("history-latest")
        expect(f.scroll.scrollTop).toBe(f.maximum())
        expect(f.setup.captureCharFrame()).toContain("Streaming while reading archive")
        expect(f.setup.renderer.root.findDescendantById("history-newer")).toBeUndefined()
    } finally { f.dispose() }
})

test.each([false, true])("rolling the latest 500 messages preserves the visible message (multiline: %s)", async (multiline) => {
    const f = await fixture(500)
    const history = (count: number) => messages(count).map((message, index) => ({
        ...message,
        content: multiline && index < 3 ? `${message.content}\nAdditional line\nThird line` : message.content,
    }))
    try {
        act(() => f.setData({ ...f.getData(), messages: history(500) }))
        await f.render()
        act(() => f.scroll.scrollTo(200))
        await f.render()
        // The scrollbar thumb may move when evicted messages have different heights.
        const visibleConversation = () => f.setup.captureCharFrame().split("\n")
            .map((line) => line.slice(f.scroll.viewport.x, f.scroll.viewport.x + f.scroll.viewport.width)).join("\n")
        const before = visibleConversation()
        act(() => f.setData({ ...f.getData(), messages: history(501) }))
        await f.render()
        expect(f.scroll.findDescendantById("user-message-message-0")).toBeUndefined()
        expect(f.scroll.findDescendantById("user-message-message-500")).toBeDefined()
        expect(visibleConversation()).toBe(before)
        act(() => f.setData({ ...f.getData(), messages: history(503) }))
        await f.render()
        expect(visibleConversation()).toBe(before)
        act(() => f.scroll.scrollTo(f.maximum()))
        await f.render()
        act(() => f.setData({ ...f.getData(), messages: history(504) }))
        await f.render()
        expect(f.scroll.scrollTop).toBe(f.maximum())
        expect(f.setup.captureCharFrame()).toContain("Message 503")
    } finally { f.dispose() }
})
