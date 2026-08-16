import {
    TextareaRenderable,
    type KeyBinding,
    type KeyEvent,
} from "@opentui/core"
import { useEffect, useRef } from "react"

import { useBuliApplicationSnapshot } from "@/application-state"
import type { TAgentRunEndReason } from "@/domain"
import {
    useBuliUiController,
    useBuliUiSnapshot,
} from "@/tui/ui-controller-state"
import { buliKeyboardController } from "@/tui/keyboard-controller"
import { theme } from "@/tui/theme"

const CHAT_MIN_ROW_COUNT = 3
const CHAT_MAX_ROW_COUNT = 6
const MENU_MAX_ROW_COUNT = 8

const chatTextAreaKeybindings: KeyBinding[] = [
    { name: "return", action: "submit" },
]

interface IChatProps {
    readonly isRunning?: boolean
    readonly lastRunReason?: TAgentRunEndReason
    readonly errorMessage?: string
}

export function Chat(props: IChatProps) {
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

    useEffect(() => {
        const textArea = textAreaRef.current
        if (textArea && textArea.plainText !== ui.input) {
            textArea.setText(ui.input)
        }
    }, [ui.input])

    const clearInput = (): void => {
        textAreaRef.current?.clear()
        controller.updateInput("")
    }

    const submitInput = (): void => {
        const input = textAreaRef.current?.plainText ?? ""
        if (!input.trim()) return

        void controller.submitInput(input).then((result) => {
            if (
                result === "consumed"
                && textAreaRef.current?.plainText === input
            ) {
                clearInput()
            }
        }).catch((error: unknown) => {
            console.error("Failed to handle input", error)
        })
    }

    const activateSelectedMenuItem = (): void => {
        const activationTask = controller.activateSelectedMenuItem()
        void activationTask.then(clearInput).catch((error: unknown) => {
            console.error("Failed to activate menu item", error)
        })
    }

    const handleKeyDown = (key: KeyEvent): void => {
        if (!ui.menu) return

        const action = buliKeyboardController.resolve("menu", key)
        if (!action) return

        key.preventDefault()
        key.stopPropagation()

        if (action === "menu.previous") controller.moveMenuSelection(-1)
        if (action === "menu.next") controller.moveMenuSelection(1)
        if (action === "menu.activate") activateSelectedMenuItem()
    }

    const menu = ui.menu
    const visibleMenuStart = menu
        ? Math.min(
            Math.max(menu.selectedIndex - Math.floor(MENU_MAX_ROW_COUNT / 2), 0),
            Math.max(menu.items.length - MENU_MAX_ROW_COUNT, 0),
        )
        : 0
    const visibleMenuItems = menu?.items.slice(
        visibleMenuStart,
        visibleMenuStart + MENU_MAX_ROW_COUNT,
    ) ?? []

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
                {props.isRunning ? (
                    <text fg={theme.amber}>Working... Esc to stop</text>
                ) : null}
                {!props.isRunning && props.lastRunReason === "aborted" ? (
                    <text fg={theme.textMuted}>Operation aborted</text>
                ) : null}
                {!props.isRunning && props.lastRunReason === "max-iterations" ? (
                    <text fg={theme.amber}>Stopped after reaching the iteration limit</text>
                ) : null}
                {props.errorMessage ? (
                    <text fg={theme.red}>{props.errorMessage}</text>
                ) : null}
                {ui.inputError ? (
                    <text fg={theme.red}>{ui.inputError}</text>
                ) : null}
                {/* Show the current model as a persistent status row. */}
                <text>
                    <span fg={theme.textMuted}>
                        {"model".padEnd(20)}
                    </span>
                    <span fg={theme.green}>
                        {selectedModelName}
                    </span>
                </text>

                {/* Show the effort that will be used by the next prompt. */}
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
                    {visibleMenuItems.map((item, index) => {
                        const absoluteIndex = visibleMenuStart + index
                        const isSelected = menu.selectedIndex === absoluteIndex

                        return (
                            <text key={item.id}>
                                <span fg={isSelected ? theme.green : theme.text}>
                                    {`${isSelected ? "→" : " "} ${item.label.padEnd(20)}`}
                                </span>
                                {item.description ? (
                                    <span fg={isSelected ? theme.green : theme.textMuted}>
                                        {item.description}
                                    </span>
                                ) : null}
                            </text>
                        )
                    })}
                    {menu.items.length === 0 && menu.emptyMessage ? (
                        <text>
                            <span fg={theme.textMuted}>{menu.emptyMessage}</span>
                        </text>
                    ) : null}
                    {menu.errorMessage ? (
                        <text>
                            <span fg={theme.red}>{menu.errorMessage}</span>
                        </text>
                    ) : null}
                </box>
            ) : null}

        </box>
    )
}
