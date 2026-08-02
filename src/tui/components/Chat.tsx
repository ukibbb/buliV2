import { TextareaRenderable, type KeyBinding } from "@opentui/core"
import { useRef } from "react"

import { useBuli } from "@/application-state"


const CHAT_MIN_ROW_COUNT = 3
const CHAT_MAX_ROW_COUNT = 6




const chatTextAreaKeybindings: KeyBinding[] = [
  { name: "return", action: "submit" }
]


interface ChatProps {
  sessionId: string
}




export function Chat(props: ChatProps) {
  console.count("Chat")
  const runtime = useBuli()
  const textAreaRef = useRef<TextareaRenderable | null>(null)

  const sendPromptToBuli = () => {
    // TODO: Trim the value, ignore empty prompts, handle rejected submissions,
    // and clear the textarea only after a successful submission.
    const message = textAreaRef.current?.plainText ?? ""

    console.log("promptSubmited", message)
    // fire async function without await
    void runtime.submitPrompt(message, props.sessionId)
  }

  const contentChange = () => {
    console.log("contentChange", textAreaRef.current?.plainText)

  }

  const cursorChange = () => {
    console.log("cursorChange", textAreaRef.current?.plainText)

  }

  return (
    <box style={{
      borderStyle: "rounded"
    }}>
      <box style={{
        borderStyle: "rounded",
        flexDirection: "row",
        minHeight: CHAT_MIN_ROW_COUNT,
        maxHeight: CHAT_MAX_ROW_COUNT
      }}>
        <box style={{
          borderStyle: "rounded",
          flexGrow: 1 // takes all horizontal space left
        }}>
          <textarea
            ref={textAreaRef}
            onSubmit={sendPromptToBuli}
            onContentChange={contentChange}
            onCursorChange={cursorChange}
            style={{
              keyBindings: chatTextAreaKeybindings,
            }}

          />
        </box>
      </box>
    </box>
  )
}
