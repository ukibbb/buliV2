export interface IBuliKey {
    readonly name: string
    readonly ctrl?: boolean
    readonly shift?: boolean
    readonly option?: boolean
    readonly meta?: boolean
    readonly super?: boolean
    readonly hyper?: boolean
}

export type TBuliKeyboardScope = "global" | "command-menu"

export type TBuliKeyboardAction =
    | "cancel"
    | "console.toggle"
    | "command.previous"
    | "command.next"
    | "command.execute"

interface IBuliKeyboardShortcut {
    readonly scope: TBuliKeyboardScope
    readonly key: IBuliKey
    readonly action: TBuliKeyboardAction
}

const SHORTCUTS: readonly IBuliKeyboardShortcut[] = [
    { scope: "global", key: { name: "escape" }, action: "cancel" },
    { scope: "global", key: { name: "d", ctrl: true }, action: "console.toggle" },
    { scope: "command-menu", key: { name: "up" }, action: "command.previous" },
    { scope: "command-menu", key: { name: "down" }, action: "command.next" },
    { scope: "command-menu", key: { name: "return" }, action: "command.execute" },
    { scope: "command-menu", key: { name: "enter" }, action: "command.execute" },
    { scope: "command-menu", key: { name: "linefeed" }, action: "command.execute" },
]

export class BuliKeyboardController {
    readonly resolve = (
        scope: TBuliKeyboardScope,
        key: IBuliKey,
    ): TBuliKeyboardAction | undefined => {
        return SHORTCUTS.find((shortcut) =>
            shortcut.scope === scope
            && shortcut.key.name === key.name
            && Boolean(shortcut.key.ctrl) === Boolean(key.ctrl)
            && Boolean(shortcut.key.shift) === Boolean(key.shift)
            && Boolean(shortcut.key.option) === Boolean(key.option)
            && Boolean(shortcut.key.meta) === Boolean(key.meta)
            && Boolean(shortcut.key.super) === Boolean(key.super)
            && Boolean(shortcut.key.hyper) === Boolean(key.hyper)
        )?.action
    }
}

export const buliKeyboardController = new BuliKeyboardController()
