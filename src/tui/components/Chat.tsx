import { TextareaRenderable, type KeyBinding } from "@opentui/core"
import { useRef } from "react"

import { useBuliRuntime } from "@/application-state"

const CHAT_MIN_ROW_COUNT = 3
const CHAT_MAX_ROW_COUNT = 6

const chatTextAreaKeybindings: KeyBinding[] = [
    { name: "return", action: "submit" },
]

interface IChatProps {
    sessionId: string
}

export function Chat(props: IChatProps) {
    console.count("Chat")
    const runtime = useBuliRuntime()
    const textAreaRef = useRef<TextareaRenderable | null>(null)

    const sendPromptToBuli = () => {
        // The OpenTUI textarea owns the draft; submission reads one plain-text snapshot.
        const message = textAreaRef.current?.plainText.trim() ?? ""
        if (!message) return

        console.log("promptSubmited", message)
        void runtime.submitPrompt({ sessionId: props.sessionId, text: message })
            .catch((error: unknown) => {
                console.error("Failed to submit prompt", error)
            })
        textAreaRef.current?.clear()

    }

    // const contentChange = () => {
    //   console.log("contentChange", textAreaRef.current?.plainText)
    // }

    // const cursorChange = () => {
    //   console.log("cursorChange", textAreaRef.current?.plainText)
    // }

    return (
        <box width="100%" flexShrink={0} flexDirection="column">
            <text>{runtime.workspaceRoot}</text>
            <box
                width="100%"
                border={["top", "bottom"]}
                borderStyle="single"
                style={{
                    minHeight: CHAT_MIN_ROW_COUNT,
                    maxHeight: CHAT_MAX_ROW_COUNT
                }}
            >
                <textarea
                    ref={textAreaRef}
                    onSubmit={sendPromptToBuli}
                    // onContentChange={contentChange}
                    // onCursorChange={cursorChange}
                    focused
                    style={{
                        keyBindings: chatTextAreaKeybindings,
                    }}
                />
            </box>
        </box>
    )
}
