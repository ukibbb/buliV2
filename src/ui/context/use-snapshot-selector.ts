import { useMemo, useSyncExternalStore } from "react"

import type { ISnapshotSource } from "@/app/contracts"

/** Caches a selected snapshot so unrelated publications do not render a subscriber. */
export function useSnapshotSelector<Snapshot, Selection>(
    source: ISnapshotSource<Snapshot>,
    select: (snapshot: Snapshot) => Selection,
    equal: (previous: Selection, next: Selection) => boolean = Object.is,
): Selection {
    const getSelection = useMemo(() => {
        let cached: { snapshot: Snapshot; selection: Selection } | undefined
        return () => {
            const snapshot = source.getSnapshot()
            if (cached && Object.is(cached.snapshot, snapshot)) return cached.selection
            const next = select(snapshot)
            const selection = cached && equal(cached.selection, next) ? cached.selection : next
            cached = { snapshot, selection }
            return selection
        }
    }, [source, select, equal])

    return useSyncExternalStore(source.subscribe, getSelection)
}

/** Compares small projections by field identity, never by message contents. */
export function sameSnapshotFields<T extends object>(previous: T, next: T): boolean {
    const keys = Object.keys(previous) as (keyof T)[]
    return keys.length === Object.keys(next).length
        && keys.every((key) => Object.hasOwn(next, key) && Object.is(previous[key], next[key]))
}
