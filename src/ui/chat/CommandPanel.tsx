import { useKeyboard } from "@opentui/react"
import type { InputRenderable, TextareaRenderable } from "@opentui/core"
import { useRef, useState } from "react"
import { useBuliUiController, useBuliUiSelector } from "@/ui/context/ui-controller-context"
import type { IBuliUiSnapshot } from "@/ui/controller/ui-controller"
import { useMenuSelectionScroll } from "@/ui/chat/use-menu-selection-scroll"
import { theme } from "@/ui/terminal/theme"

export function CommandPanel() {
    const panel = useBuliUiSelector(selectPanel)
    if (!panel) return null
    return <box id="saved-commands" width="100%" minHeight={0} flexShrink={1} flexDirection="column" paddingX={1}>
        <text fg={theme.pink}>{panel.mode === "list" ? "Commands" : "Add command"}</text>
        {panel.mode === "list" ? <CommandList commands={panel.commands} /> : <CommandForm />}
        {panel.error ? <text fg={theme.red}>{panel.error}</text> : null}
    </box>
}

function CommandList({ commands }: { readonly commands: readonly { readonly name: string }[] }) {
    const controller = useBuliUiController()
    const [selected, setSelected] = useState(0)
    const selection = Math.min(selected, commands.length)
    const scrollRef = useMenuSelectionScroll(selection, commands)
    useKeyboard(key => {
        if (key.eventType === "release") return
        if (!["up", "down", "tab", "return", "enter", "delete", "backspace"].includes(key.name)) return
        key.preventDefault()
        key.stopPropagation()
        if (key.name === "up" || (key.name === "tab" && key.shift)) setSelected((selection + commands.length) % (commands.length + 1))
        else if (key.name === "down" || key.name === "tab") setSelected((selection + 1) % (commands.length + 1))
        else if (selection < commands.length) controller.removeCommand(commands[selection]!.name)
        else if (key.name === "return" || key.name === "enter") controller.showAddCommand()
    })
    return <scrollbox ref={scrollRef} maxHeight={8} minHeight={0} scrollY scrollX={false}>
        {commands.map((command, index) => <box key={command.name} flexDirection="row" height={1}>
            <text fg={theme.text} flexGrow={1}>{` /${command.name}`}</text>
            <text id={`delete-command-${command.name}`} selectable={false} fg={selection === index ? theme.green : theme.textSecondary}
                onMouseDown={() => controller.removeCommand(command.name)}>{`${selection === index ? "→ " : "  "}[×]`}</text>
        </box>)}
        <text id="add-command" selectable={false} fg={selection === commands.length ? theme.green : theme.textSecondary}
            onMouseDown={controller.showAddCommand}>{`${selection === commands.length ? "→ " : "  "}[Add new]`}</text>
        <text fg={theme.textSecondary}>↑/↓ select · Enter activate · Esc close</text>
    </scrollbox>
}

function CommandForm() {
    const controller = useBuliUiController()
    const nameRef = useRef<InputRenderable | null>(null)
    const promptRef = useRef<TextareaRenderable | null>(null)
    const [focus, setFocus] = useState(0)
    const save = () => controller.saveCommand(nameRef.current?.value ?? "", promptRef.current?.plainText ?? "")
    useKeyboard(key => {
        if (key.eventType === "release") return
        if (key.name === "tab") {
            key.preventDefault()
            key.stopPropagation()
            setFocus((focus + (key.shift ? 3 : 1)) % 4)
        } else if ((key.name === "return" || key.name === "enter") && focus !== 1) {
            key.preventDefault()
            key.stopPropagation()
            if (focus === 0) setFocus(1)
            else if (focus === 2) controller.openCommands()
            else save()
        }
    })
    return <box flexDirection="column" minHeight={0}>
        <text>Name</text>
        <input id="command-name" ref={nameRef} focused={focus === 0} placeholder="review" onMouseDown={() => setFocus(0)} />
        <text>Prompt</text>
        <textarea id="command-prompt" ref={promptRef} focused={focus === 1} height={5} minHeight={2}
            onMouseDown={() => setFocus(1)} />
        <box flexDirection="row" height={1} gap={3}>
            <text id="cancel-command" selectable={false} fg={focus === 2 ? theme.green : theme.textSecondary}
                onMouseDown={() => controller.openCommands()}>[Cancel]</text>
            <text id="save-command" selectable={false} fg={focus === 3 ? theme.green : theme.textSecondary}
                onMouseDown={save}>[OK]</text>
        </box>
        <text fg={theme.textSecondary}>Tab next field · Enter in Prompt adds a line · Esc cancel</text>
    </box>
}

const selectPanel = (snapshot: IBuliUiSnapshot) => snapshot.commandPanel
