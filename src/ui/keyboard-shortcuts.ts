import {
    KeyboardShortcutResolver,
    type IKeyboardShortcut,
} from "@/ui/terminal/input/shortcut-resolver"

export type TBuliKeyboardScope = "global" | "input" | "menu"

export type TBuliKeyboardAction =
    | "cancel"
    | "console.toggle"
    | "input.followUp"
    | "input.pasteClipboard"
    | "menu.previous"
    | "menu.next"
    | "menu.activate"

type TBuliKeyboardShortcut = IKeyboardShortcut<
    TBuliKeyboardScope,
    TBuliKeyboardAction
>

const SHORTCUTS: readonly TBuliKeyboardShortcut[] = [
    { scope: "global", key: { name: "escape" }, action: "cancel" },
    { scope: "global", key: { name: "d", ctrl: true }, action: "console.toggle" },
    { scope: "input", key: { name: "v", ctrl: true }, action: "input.pasteClipboard" },
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

export const buliKeyboardShortcuts = new KeyboardShortcutResolver<
    TBuliKeyboardScope,
    TBuliKeyboardAction
>(SHORTCUTS)
