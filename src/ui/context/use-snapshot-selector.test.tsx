import { testRender } from "@opentui/react/test-utils"
import { expect, test } from "bun:test"
import { act, useState } from "react"

import type { ISnapshotSource } from "@/app/contracts"
import { sameSnapshotFields, useSnapshotSelector } from "@/ui/context/use-snapshot-selector"

function createSource<T>(initial: T) {
    let snapshot = initial
    const listeners = new Set<() => void>()
    return {
        getSnapshot: () => snapshot,
        subscribe(listener: () => void) {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
        },
        publish(next: T) {
            snapshot = next
            for (const listener of [...listeners]) listener()
        },
        get subscriberCount() { return listeners.size },
    }
}

test("selectors preserve field identity across unrelated publications and observe new queue contents", async () => {
    const queued = [{ id: "queued", content: "Original content" }]
    const source = createSource({ chunk: "", queued })
    const select = (snapshot: ReturnType<typeof source.getSnapshot>) => ({ queued: snapshot.queued })
    let renders = 0
    let selected: ReturnType<typeof select> | undefined
    function Fixture() {
        selected = useSnapshotSelector(source, select, sameSnapshotFields)
        renders++
        return <text>{selected.queued[0]?.content}</text>
    }
    const setup = await testRender(<Fixture />, { width: 40, height: 5 })
    try {
        const initialRenders = renders
        const initialSelection = selected
        await act(async () => {
            source.publish({ chunk: "next chunk", queued })
            source.publish({ chunk: "another chunk", queued })
            await setup.renderOnce()
        })
        expect(renders).toBe(initialRenders)
        expect(selected).toBe(initialSelection)
        await act(async () => {
            source.publish({ chunk: "another chunk", queued: [{ id: "queued", content: "Changed content" }] })
            await setup.renderOnce()
        })
        expect(renders).toBeGreaterThan(initialRenders)
        expect(selected).not.toBe(initialSelection)
        expect(setup.captureCharFrame()).toContain("Changed content")
    } finally {
        act(() => setup.renderer.destroy())
    }
    expect(source.subscriberCount).toBe(0)
})

test("selectors switch source, selection and equality without retaining an old subscription", async () => {
    type Snapshot = { first: string; second: string }
    type Configuration = {
        source: ISnapshotSource<Snapshot>
        select: (snapshot: Snapshot) => string
        equal: (previous: string, next: string) => boolean
    }
    const first = createSource({ first: "alpha", second: "beta" })
    const second = createSource({ first: "gamma", second: "delta" })
    const selectFirst = (snapshot: Snapshot) => snapshot.first
    const selectSecond = (snapshot: Snapshot) => snapshot.second
    let configure!: (configuration: Configuration) => void
    let renders = 0
    function Fixture() {
        const [configuration, setConfiguration] = useState<Configuration>({
            source: first, select: selectFirst, equal: Object.is,
        })
        configure = setConfiguration
        const value = useSnapshotSelector(configuration.source, configuration.select, configuration.equal)
        renders++
        return <text>{value}</text>
    }
    const setup = await testRender(<Fixture />, { width: 40, height: 5 })
    const update = async (configuration: Configuration) => {
        act(() => configure(configuration))
        await act(async () => { await setup.renderOnce() })
    }
    try {
        expect(first.subscriberCount).toBe(1)
        await update({ source: second, select: selectFirst, equal: Object.is })
        expect(first.subscriberCount).toBe(0)
        expect(second.subscriberCount).toBe(1)
        expect(setup.captureCharFrame()).toContain("gamma")
        const sourceRenders = renders
        act(() => first.publish({ first: "obsolete", second: "obsolete" }))
        expect(renders).toBe(sourceRenders)
        await update({ source: second, select: selectSecond, equal: Object.is })
        expect(setup.captureCharFrame()).toContain("delta")
        await update({ source: second, select: selectSecond, equal: () => true })
        const equalRenders = renders
        await act(async () => {
            second.publish({ first: "gamma", second: "epsilon" })
            await setup.renderOnce()
        })
        expect(renders).toBe(equalRenders)
        expect(setup.captureCharFrame()).toContain("delta")
        await update({ source: second, select: selectSecond, equal: Object.is })
        expect(setup.captureCharFrame()).toContain("epsilon")
    } finally {
        act(() => setup.renderer.destroy())
    }
    expect(first.subscriberCount).toBe(0)
    expect(second.subscriberCount).toBe(0)
})

test("snapshot field equality checks keys and Object.is values without deep comparison", () => {
    const shared = ["message"]
    expect(sameSnapshotFields({ shared }, { shared })).toBe(true)
    expect(sameSnapshotFields({ shared }, { shared: [...shared] })).toBe(false)
    expect(sameSnapshotFields({ value: undefined }, { other: undefined })).toBe(false)
    expect(sameSnapshotFields({ value: 1 }, { value: 1, other: 2 })).toBe(false)
    expect(sameSnapshotFields({ value: NaN }, { value: NaN })).toBe(true)
    expect(sameSnapshotFields({ value: 0 }, { value: -0 })).toBe(false)
})
