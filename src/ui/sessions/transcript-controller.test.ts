import { expect, spyOn, test } from "bun:test"

import type { ISessionSource } from "@/app/contracts"
import type { IHistoryPage } from "@/sessions"
import { TranscriptController } from "@/ui/sessions/transcript-controller"
import { createSessionTestSource, type ISessionTestData } from "../../../test/fixtures/session-source"

function fixture() {
    const data: ISessionTestData = {
        activeBranchId: "main", messages: [], isRunning: false, isCompacting: false,
        pendingSteeringMessages: [], pendingFollowUpMessages: [], pendingToolCallIds: [],
    }
    const source = createSessionTestSource(data)
    const latest: IHistoryPage = {
        sessionId: "session", branchId: "main", messages: [],
        olderCursor: { sessionId: "session", branchId: "main", beforeMessageId: "boundary" },
    }
    const older: IHistoryPage = { sessionId: "session", branchId: "main", messages: [] }
    const load = spyOn(source.source, "loadHistoryPage").mockImplementation((_branch, cursor) => cursor ? older : latest)
    const controller = new TranscriptController(source.source)
    controller.connect()
    return { ...source, controller, load, latest, older }
}

test("latest presentation stays live without navigating or rereading history for stream updates", async () => {
    const f = fixture()
    try {
        expect(await f.controller.latest()).toBe(true)
        const before = f.controller.getSnapshot()
        f.setData({ ...f.getData(), isCompacting: true, compactionProgress: {
            id: "new", throughMessageId: "boundary", summary: "Live update",
        } })
        const live = f.controller.getSnapshot()
        expect(live.pageKind).toBe("latest")
        expect(live.page).toBe(before.page)
        expect(live.presentation.compactionProgress?.summary).toBe("Live update")
        expect(live.navigationRevision).toBe(before.navigationRevision)
        expect(f.load).toHaveBeenCalledTimes(1)
        f.setData({ ...f.getData(), messages: [] })
        expect(f.load).toHaveBeenCalledTimes(2)
        expect(f.controller.getSnapshot().navigationRevision).toBe(before.navigationRevision)
    } finally { f.controller.dispose() }
})

test("older navigation replaces the page and stops at the archive boundary", async () => {
    const f = fixture()
    try {
        await f.controller.latest()
        expect(await f.controller.older()).toBe(true)
        expect(f.load).toHaveBeenLastCalledWith("main", f.latest.olderCursor)
        expect(f.controller.getSnapshot().page).toBe(f.older)
        expect(f.controller.getSnapshot().pageKind).toBe("older")
        expect(await f.controller.older()).toBe(false)
        expect(f.load).toHaveBeenCalledTimes(2)
    } finally { f.controller.dispose() }
})

test("failed explicit return preserves the archived page and return path", async () => {
    const f = fixture()
    try {
        await f.controller.latest()
        await f.controller.older()
        const frozen = f.controller.getSnapshot()
        f.load.mockImplementation(() => { throw new Error("Unavailable archive") })
        expect(await f.controller.latest()).toBe(false)
        expect(f.controller.getSnapshot()).toMatchObject({
            pageKind: "older", page: frozen.page, presentation: frozen.presentation,
            loading: false, error: "Unavailable archive",
        })
        f.setData({ ...f.getData(), isRunning: true })
        expect(f.controller.getSnapshot().presentation).toBe(frozen.presentation)
        f.load.mockReturnValue(f.latest)
        expect(await f.controller.newer()).toBe(true)
        expect(f.load).toHaveBeenLastCalledWith("main", undefined)
        expect(f.controller.getSnapshot().pageKind).toBe("latest")
        expect(f.controller.getSnapshot().presentation.isRunning).toBe(true)
    } finally { f.controller.dispose() }
})

test("walks archive cursors in both directions and returns to fresh latest data", async () => {
    const f = fixture()
    const middle: IHistoryPage = { ...f.older,
        olderCursor: { sessionId: "session", branchId: "main", beforeMessageId: "oldest-boundary" } }
    f.load.mockImplementation((_branch, cursor) => !cursor ? f.latest
        : cursor.beforeMessageId === "boundary" ? middle : f.older)
    try {
        await f.controller.latest()
        await f.controller.older()
        const archived = f.controller.getSnapshot()
        f.setData({ ...f.getData(), messages: [], isRunning: true })
        expect(f.controller.getSnapshot()).toBe(archived)
        expect(f.load).toHaveBeenCalledTimes(2)
        await f.controller.older()
        expect(f.controller.getSnapshot().page).toBe(f.older)
        await f.controller.newer()
        expect(f.controller.getSnapshot().page).toBe(middle)
        expect(f.load).toHaveBeenLastCalledWith("main", f.latest.olderCursor)
        await f.controller.newer()
        expect(f.load).toHaveBeenLastCalledWith("main", undefined)
        expect(f.controller.getSnapshot().pageKind).toBe("latest")
        expect(f.controller.getSnapshot().presentation.isRunning).toBe(true)
        expect(await f.controller.newer()).toBe(false)
        await f.controller.older()
        await f.controller.older()
        await f.controller.latest()
        expect(await f.controller.newer()).toBe(false)
        expect(f.controller.getSnapshot().pageKind).toBe("latest")
    } finally { f.controller.dispose() }
})

test("failed older navigation leaves the latest page live and does not add a return cursor", async () => {
    const f = fixture()
    try {
        await f.controller.latest()
        const before = f.controller.getSnapshot()
        f.load.mockImplementation(() => { throw new Error("Read failed") })
        expect(await f.controller.older()).toBe(false)
        expect(f.controller.getSnapshot().page).toBe(before.page)
        expect(f.controller.getSnapshot().navigationRevision).toBe(before.navigationRevision)
        expect(f.controller.getSnapshot().pageKind).toBe("latest")
        expect(await f.controller.newer()).toBe(false)
        f.setData({ ...f.getData(), isRunning: true })
        expect(f.controller.getSnapshot().presentation.isRunning).toBe(true)
    } finally { f.controller.dispose() }
})

test("switching branches from an archive clears the old return path", async () => {
    const f = fixture()
    try {
        await f.controller.latest()
        await f.controller.older()
        f.setData({ ...f.getData(), activeBranchId: "side" })
        expect(f.load).toHaveBeenLastCalledWith("side", undefined)
        expect(f.controller.getSnapshot().presentation.activeBranchId).toBe("side")
        expect(f.controller.getSnapshot().pageKind).toBe("latest")
        expect(await f.controller.newer()).toBe(false)
    } finally { f.controller.dispose() }
})

test("reentrant branch navigation rejects the stale read instead of replacing the new page", async () => {
    const f = fixture()
    try {
        let switched = false
        const side: IHistoryPage = { ...f.older, branchId: "side" }
        f.load.mockImplementation((branch) => {
            if (branch === "main" && !switched) {
                switched = true
                f.setData({ ...f.getData(), activeBranchId: "side" })
                return f.latest
            }
            return side
        })
        expect(await f.controller.latest()).toBe(false)
        expect(f.controller.getSnapshot().page).toBe(side)
        expect(f.controller.getSnapshot().presentation.activeBranchId).toBe("side")
    } finally { f.controller.dispose() }
})

test("disposal releases live/history subscriptions and invalidates an in-flight read", async () => {
    const f = fixture()
    const frozen = f.controller.getSnapshot()
    f.load.mockImplementation(() => { f.controller.dispose(); return f.latest })
    expect(await f.controller.latest()).toBe(false)
    const stopped = f.controller.getSnapshot()
    f.setData({ ...f.getData(), isRunning: true, messages: [] })
    expect(f.controller.getSnapshot()).toBe(stopped)
    expect(stopped.presentation).toBe(frozen.presentation)
    expect(f.load).toHaveBeenCalledTimes(1)
})

test("controller constructor does not load message payloads", () => {
    const source: ISessionSource = createSessionTestSource({
        activeBranchId: "main", messages: [], isRunning: false, isCompacting: false,
        pendingSteeringMessages: [], pendingFollowUpMessages: [], pendingToolCallIds: [],
    }).source
    const load = spyOn(source, "loadHistoryPage")
    const subscribe = spyOn(source, "subscribe")
    const subscribeHistory = spyOn(source, "subscribeHistory")
    const controller = new TranscriptController(source)
    expect(load).not.toHaveBeenCalled()
    expect(subscribe).not.toHaveBeenCalled()
    expect(subscribeHistory).not.toHaveBeenCalled()
    controller.connect()
    expect(subscribe).toHaveBeenCalledTimes(1)
    controller.dispose()
    controller.connect()
    expect(subscribe).toHaveBeenCalledTimes(2)
    controller.dispose()
})
