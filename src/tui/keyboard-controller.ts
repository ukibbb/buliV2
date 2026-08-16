export interface IBuliKey {
    readonly name: string
    readonly ctrl?: boolean
    readonly shift?: boolean
    readonly option?: boolean
    readonly meta?: boolean
    readonly super?: boolean
    readonly hyper?: boolean
}

export type TBuliKeyboardScope = "global" | "input" | "menu"

export type TBuliKeyboardAction =
    | "cancel"
    | "console.toggle"
    | "input.followUp"
    | "menu.previous"
    | "menu.next"
    | "menu.activate"

interface IBuliKeyboardShortcut {
    readonly scope: TBuliKeyboardScope
    readonly key: IBuliKey
    readonly action: TBuliKeyboardAction
}

const SHORTCUTS: readonly IBuliKeyboardShortcut[] = [
    { scope: "global", key: { name: "escape" }, action: "cancel" },
    { scope: "global", key: { name: "d", ctrl: true }, action: "console.toggle" },
    // Raw terminals encode Alt as `meta`; Kitty additionally marks `option`.
    // Register both shapes so Alt+Enter behaves identically in either protocol.
    { scope: "input", key: { name: "return", meta: true }, action: "input.followUp" },
    { scope: "input", key: { name: "enter", meta: true }, action: "input.followUp" },
    { scope: "input", key: { name: "kpenter", meta: true }, action: "input.followUp" },
    { scope: "input", key: { name: "linefeed", meta: true }, action: "input.followUp" },
    {
        scope: "input",
        key: { name: "return", meta: true, option: true },
        action: "input.followUp",
    },
    {
        scope: "input",
        key: { name: "enter", meta: true, option: true },
        action: "input.followUp",
    },
    {
        scope: "input",
        key: { name: "kpenter", meta: true, option: true },
        action: "input.followUp",
    },
    {
        scope: "input",
        key: { name: "linefeed", meta: true, option: true },
        action: "input.followUp",
    },
    { scope: "menu", key: { name: "up" }, action: "menu.previous" },
    { scope: "menu", key: { name: "down" }, action: "menu.next" },
    { scope: "menu", key: { name: "return" }, action: "menu.activate" },
    { scope: "menu", key: { name: "enter" }, action: "menu.activate" },
    { scope: "menu", key: { name: "linefeed" }, action: "menu.activate" },
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
