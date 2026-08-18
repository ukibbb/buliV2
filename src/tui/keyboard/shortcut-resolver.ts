export interface ITuiKey {
    readonly name: string
    readonly ctrl?: boolean
    readonly shift?: boolean
    readonly option?: boolean
    readonly meta?: boolean
    readonly super?: boolean
    readonly hyper?: boolean
}

export interface IKeyboardShortcut<
    TScope extends string,
    TAction extends string,
> {
    readonly scope: TScope
    readonly key: ITuiKey
    readonly action: TAction
}

/** Resolves exact key/modifier combinations without owning UI state. */
export class KeyboardShortcutResolver<
    TScope extends string,
    TAction extends string,
> {
    constructor(
        private readonly shortcuts: readonly IKeyboardShortcut<TScope, TAction>[],
    ) {}

    readonly resolve = (
        scope: TScope,
        key: ITuiKey,
    ): TAction | undefined => {
        return this.shortcuts.find((shortcut) =>
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
