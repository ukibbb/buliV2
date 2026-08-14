import {
    TextareaRenderable,
    type KeyBinding,
    type KeyEvent,
} from "@opentui/core"
import { useRef } from "react"

import { useBuliApplicationSnapshot } from "@/application-state"
import {
    useBuliUiController,
    useBuliUiSnapshot,
} from "@/tui/ui-controller-state"
import { buliKeyboardController } from "@/tui/keyboard-controller"
import { theme } from "@/tui/theme"

const CHAT_MIN_ROW_COUNT = 3
const CHAT_MAX_ROW_COUNT = 6

const chatTextAreaKeybindings: KeyBinding[] = [
    { name: "return", action: "submit" },
]

export function Chat() {
    const controller = useBuliUiController()
    const ui = useBuliUiSnapshot()
    const applicationSnapshot = useBuliApplicationSnapshot()
    // Pobierz reaktywny globalny snapshot aplikacji.
    const selectedModel = applicationSnapshot.models.find(
        (model) => model.id === applicationSnapshot.selection.modelId,
    )
    // Znajdź informacje o wybranym modelu.
    const selectedModelName = selectedModel?.name
        ?? applicationSnapshot.selection.modelId
    // Użyj nazwy modelu albo jego ID jako fallbacku.
    const textAreaRef = useRef<TextareaRenderable | null>(null)

    const clearInput = (): void => {
        textAreaRef.current?.clear()
        controller.updateInput("")
    }

    const submitInput = (): void => {
        const input = textAreaRef.current?.plainText ?? ""
        if (!input.trim()) return

        clearInput()
        void controller.submitInput(input).catch((error: unknown) => {
            console.error("Failed to handle input", error)
        })
    }

    const executeSelectedCommand = (): void => {
        const commandTask = controller.executeSelectedCommand()
        clearInput()
        void commandTask.catch((error: unknown) => {
            console.error("Failed to execute command", error)
        })
    }

    const handleKeyDown = (key: KeyEvent): void => {
        if (!ui.commandMenu) return

        const action = buliKeyboardController.resolve("command-menu", key)
        if (!action) return

        key.preventDefault()
        key.stopPropagation()

        if (action === "command.previous") controller.moveCommandSelection(-1)
        if (action === "command.next") controller.moveCommandSelection(1)
        if (action === "command.execute") executeSelectedCommand()
    }

    const menu = ui.commandMenu

    return (
        <box width="100%" flexShrink={0} flexDirection="column">
            <text>{controller.workspaceRoot}</text>
            <box
                width="100%"
                border={["top", "bottom"]}
                borderStyle="single"
                style={{
                    minHeight: CHAT_MIN_ROW_COUNT,
                    maxHeight: CHAT_MAX_ROW_COUNT,
                }}
            >
                <textarea
                    ref={textAreaRef}
                    onSubmit={submitInput}
                    onKeyDown={handleKeyDown}
                    onContentChange={() => {
                        controller.updateInput(
                            textAreaRef.current?.plainText ?? "",
                        )
                    }}
                    focused
                    style={{
                        keyBindings: chatTextAreaKeybindings,
                    }}
                />
            </box>
            <box
                width="100%"
                flexShrink={0}
                flexDirection="column"
                paddingLeft={1}
                paddingBottom={1}
            >
                {/* Pokaż aktualny model jako stały wiersz statusu. */}
                <text>
                    <span fg={theme.textMuted}>
                        {"model".padEnd(20)}
                    </span>
                    <span fg={theme.green}>
                        {selectedModelName}
                    </span>
                </text>

                {/* Pokaż effort używany przez następny prompt. */}
                <text>
                    <span fg={theme.textMuted}>
                        {"reasoning".padEnd(20)}
                    </span>
                    <span fg={theme.amber}>
                        {applicationSnapshot.selection.reasoningEffort}
                    </span>
                </text>
            </box>
            {menu ? (
                <box
                    width="100%"
                    flexDirection="column"
                    paddingLeft={1}
                    paddingBottom={1}
                >
                    {menu.items.map((command, index) => {
                        const isSelected = menu.selectedIndex === index

                        return (
                            <text key={command.name}>
                                <span fg={isSelected ? theme.green : theme.text}>
                                    {`${isSelected ? "→" : " "} ${command.name.padEnd(20)}`}
                                </span>
                                <span fg={isSelected ? theme.green : theme.textMuted}>
                                    {command.description}
                                </span>
                            </text>
                        )
                    }
                    )}
                </box>
            ) : null}

        </box>
    )
}
