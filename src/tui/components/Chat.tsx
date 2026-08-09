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
  }

  const contentChange = () => {
    console.log("contentChange", textAreaRef.current?.plainText)
  }

  const cursorChange = () => {
    console.log("cursorChange", textAreaRef.current?.plainText)
  }

  return (
    <box style={{ borderStyle: "rounded" }}>
      <box
        style={{
          borderStyle: "rounded",
          flexDirection: "row",
          minHeight: CHAT_MIN_ROW_COUNT,
          maxHeight: CHAT_MAX_ROW_COUNT,
        }}
      >
        <box
          style={{
            borderStyle: "rounded",
            flexGrow: 1, // takes all horizontal space left
            width: "100%",
          }}
        >
          <textarea
            ref={textAreaRef}
            onSubmit={sendPromptToBuli}
            onContentChange={contentChange}
            onCursorChange={cursorChange}
            focused
            style={{
              keyBindings: chatTextAreaKeybindings,
            }}
          />
        </box>
      </box>
    </box>
  )
}
