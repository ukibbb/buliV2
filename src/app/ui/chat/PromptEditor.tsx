import {
    TextareaRenderable,
    type KeyBinding,
    type KeyEvent,
} from "@opentui/core"
import { useEffect, useRef } from "react"

import { buliKeyboardShortcuts } from "@/app/ui/keyboard-shortcuts"
import type {
    TBuliInputDelivery,
    TBuliInputSubmitResult,
} from "@/app/ui/ui-controller"
import { theme } from "@/terminal/theme"

const CHAT_MIN_ROW_COUNT = 3
const CHAT_MAX_ROW_COUNT = 6

const chatTextAreaKeybindings: KeyBinding[] = [
    { name: "return", action: "submit" },
]

interface IPromptEditorProps {
    readonly value: string
    readonly blocked: boolean
    readonly menuOpen: boolean
    readonly getCurrentValue: () => string
    readonly onValueChange: (value: string) => void
    readonly onSubmit: (
        input: string,
        delivery: TBuliInputDelivery,
    ) => Promise<TBuliInputSubmitResult>
    readonly onMoveMenuSelection: (direction: -1 | 1) => void
    readonly onActivateMenuItem: () => Promise<void>
}

/** Owns the controlled terminal textarea, focus, keys, and safe draft clearing. */
export function PromptEditor(props: IPromptEditorProps) {
    const textAreaRef = useRef<TextareaRenderable | null>(null)

    useEffect(() => {
        const textArea = textAreaRef.current
        if (textArea && textArea.plainText !== props.value) {
            textArea.setText(props.value)
        }
    }, [props.value])

    const clearSubmittedDraft = (submittedDraft: string): void => {
        const textArea = textAreaRef.current
        if (!textArea || textArea.plainText !== submittedDraft) return
        textArea.clear()
        props.onValueChange("")
    }

    const submitInput = (delivery: TBuliInputDelivery): void => {
        if (props.blocked) return
        const input = textAreaRef.current?.plainText ?? ""
        if (!input.trim()) return

        void props.onSubmit(input, delivery).then((result) => {
            if (result === "consumed") clearSubmittedDraft(input)
        }).catch((error: unknown) => {
            console.error("Failed to handle input", error)
        })
    }

    const activateSelectedMenuItem = (): void => {
        void props.onActivateMenuItem().catch((error: unknown) => {
            console.error("Failed to activate menu item", error)
        })
    }

    const handleKeyDown = (key: KeyEvent): void => {
        if (props.blocked) {
            key.preventDefault()
            key.stopPropagation()
            return
        }

        const inputAction = buliKeyboardShortcuts.resolve("input", key)
        if (inputAction === "input.followUp") {
            key.preventDefault()
            key.stopPropagation()
            submitInput("followUp")
            return
        }

        if (!props.menuOpen) return

        const action = buliKeyboardShortcuts.resolve("menu", key)
        if (!action) return

        key.preventDefault()
        key.stopPropagation()

        if (action === "menu.previous") props.onMoveMenuSelection(-1)
        if (action === "menu.next") props.onMoveMenuSelection(1)
        if (action === "menu.activate") activateSelectedMenuItem()
    }

    return (
        <box
            width="100%"
            border={["top", "bottom"]}
            borderStyle="single"
            borderColor={props.blocked ? theme.amber : theme.border}
            backgroundColor={theme.surface}
            paddingX={1}
            style={{
                minHeight: CHAT_MIN_ROW_COUNT,
                maxHeight: props.menuOpen
                    ? CHAT_MIN_ROW_COUNT
                    : CHAT_MAX_ROW_COUNT,
            }}
        >
            <textarea
                ref={textAreaRef}
                initialValue={props.value}
                onSubmit={() => submitInput("auto")}
                onKeyDown={handleKeyDown}
                onContentChange={() => {
                    const input = textAreaRef.current?.plainText ?? ""
                    if (input !== props.getCurrentValue()) {
                        props.onValueChange(input)
                    }
                }}
                focused={!props.blocked}
                textColor={theme.text}
                focusedTextColor={theme.text}
                backgroundColor={theme.surface}
                focusedBackgroundColor={theme.surface}
                placeholderColor={theme.textMuted}
                cursorColor={theme.green}
                cursorStyle={{ style: "line", blinking: true }}
                showCursor={!props.blocked}
                selectionBg={theme.selectionBg}
                selectionFg={theme.selectionFg}
                style={{ keyBindings: chatTextAreaKeybindings }}
            />
        </box>
    )
}
