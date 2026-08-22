import {
    KeyboardShortcutResolver,
    type IKeyboardShortcut,
} from "@/terminal/input/shortcut-resolver"

export type TAuthenticationKeyboardScope = "flow"

export type TAuthenticationKeyboardAction =
    | "cancel"
    | "accept"
    | "scroll.up"
    | "scroll.down"

type TAuthenticationKeyboardShortcut = IKeyboardShortcut<
    TAuthenticationKeyboardScope,
    TAuthenticationKeyboardAction
>

const SHORTCUTS: readonly TAuthenticationKeyboardShortcut[] = [
    { scope: "flow", key: { name: "escape" }, action: "cancel" },
    { scope: "flow", key: { name: "return" }, action: "accept" },
    { scope: "flow", key: { name: "enter" }, action: "accept" },
    { scope: "flow", key: { name: "linefeed" }, action: "accept" },
    { scope: "flow", key: { name: "pageup" }, action: "scroll.up" },
    { scope: "flow", key: { name: "pagedown" }, action: "scroll.down" },
]

export const authenticationKeyboardShortcuts = new KeyboardShortcutResolver<
    TAuthenticationKeyboardScope,
    TAuthenticationKeyboardAction
>(SHORTCUTS)
