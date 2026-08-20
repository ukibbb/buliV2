import {
    KeyboardShortcutResolver,
    type IKeyboardShortcut,
    type ITuiKey,
} from "@/tui/keyboard/shortcut-resolver"

export type TBuliKeyboardScope = "global" | "input" | "menu" | "approval"

export type TBuliKeyboardAction =
    | "cancel"
    | "console.toggle"
    | "input.followUp"
    | "approval.previous"
    | "approval.next"
    | "approval.activate"
    | "approval.scrollUp"
    | "approval.scrollDown"
    | "approval.scrollStart"
    | "approval.scrollEnd"
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
    { scope: "approval", key: { name: "up" }, action: "approval.previous" },
    { scope: "approval", key: { name: "left" }, action: "approval.previous" },
    { scope: "approval", key: { name: "down" }, action: "approval.next" },
    { scope: "approval", key: { name: "right" }, action: "approval.next" },
    { scope: "approval", key: { name: "return" }, action: "approval.activate" },
    { scope: "approval", key: { name: "enter" }, action: "approval.activate" },
    { scope: "approval", key: { name: "linefeed" }, action: "approval.activate" },
    { scope: "approval", key: { name: "pageup" }, action: "approval.scrollUp" },
    { scope: "approval", key: { name: "pagedown" }, action: "approval.scrollDown" },
    { scope: "approval", key: { name: "home" }, action: "approval.scrollStart" },
    { scope: "approval", key: { name: "end" }, action: "approval.scrollEnd" },
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

export function resolveApprovalKeyboardAction(
    key: ITuiKey,
): TBuliKeyboardAction | undefined {
    return buliKeyboardShortcuts.resolve("approval", key)
}
