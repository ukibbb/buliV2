import {
    TextareaRenderable,
    type KeyBinding,
    type KeyEvent,
} from "@opentui/core"
import { useEffect, useRef } from "react"

import { useBuliApplicationSnapshot } from "@/tui/app/application-context"
import type { IUserMessage, TAgentRunEndReason } from "@/domain"
import {
    useBuliUiController,
    useBuliUiSnapshot,
} from "@/tui/app/ui-controller-context"
import type { TBuliInputDelivery } from "@/tui/app/ui-controller"
import { buliKeyboardShortcuts } from "@/tui/app/keyboard-shortcuts"
import { theme } from "@/tui/theme"

const CHAT_MIN_ROW_COUNT = 3
const CHAT_MAX_ROW_COUNT = 6
const MENU_MAX_ROW_COUNT = 8

const chatTextAreaKeybindings: KeyBinding[] = [
    { name: "return", action: "submit" },
]

interface IChatProps {
    readonly isRunning?: boolean
    readonly pendingSteeringMessages?: readonly IUserMessage[]
    readonly pendingFollowUpMessages?: readonly IUserMessage[]
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

    const submitInput = (delivery: TBuliInputDelivery): void => {
        const input = textAreaRef.current?.plainText ?? ""
        if (!input.trim()) return

        void controller.submitInput(input, delivery).then((result) => {
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
        // Kontroler zna snapshot inputu, który uruchomił komendę, więc tylko on
        // może bezpiecznie zdecydować, czy po async completion wyczyścić draft.
        void controller.activateSelectedMenuItem().catch((error: unknown) => {
            console.error("Failed to activate menu item", error)
        })
    }

    const handleKeyDown = (key: KeyEvent): void => {
        const inputAction = buliKeyboardShortcuts.resolve("input", key)
        if (inputAction === "input.followUp") {
            key.preventDefault()
            key.stopPropagation()
            submitInput("followUp")
            return
        }

        if (!ui.menu) return

        const action = buliKeyboardShortcuts.resolve("menu", key)
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
                    initialValue={ui.input}
                    onSubmit={() => submitInput("auto")}
                    onKeyDown={handleKeyDown}
                    onContentChange={() => {
                        const input = textAreaRef.current?.plainText ?? ""
                        if (input !== controller.getSnapshot().input) {
                            controller.updateInput(input)
                        }
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
                    <text fg={theme.amber}>
                        Working... Enter steer | Alt+Enter follow-up | Esc stop
                    </text>
                ) : null}
                {props.pendingSteeringMessages?.map((message) => (
                    <text key={message.id} fg={theme.textMuted}>
                        {`Steering: ${message.content}`}
                    </text>
                ))}
                {props.pendingFollowUpMessages?.map((message) => (
                    <text key={message.id} fg={theme.textMuted}>
                        {`Follow-up: ${message.content}`}
                    </text>
                ))}
                {(
                    (props.pendingSteeringMessages?.length ?? 0)
                    + (props.pendingFollowUpMessages?.length ?? 0)
                ) > 0 ? (
                    <text fg={theme.textMuted}>Esc restores queued input</text>
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
