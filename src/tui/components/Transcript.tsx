import type { ReactNode } from "react"
import type { IBuliMessageWithParts, Part } from "@/domain"
import { theme } from "@/tui/theme"

interface ITranscriptProps {
  messages: readonly IBuliMessageWithParts[]
}

interface IUserCardProps {
  parts: readonly Part[]
}

function UserCard(props: IUserCardProps): ReactNode {
  const text = props.parts
    // map callback Part to string result string[]
    .map((part) => part.text.trim())
    // filter callback string->boolean result string[]
    .filter((partText) => partText.length > 0)
    .join("\n\n")

  return <text>{text}</text>
}
interface IBuliCardProps {
  parts: readonly Part[]
}

function BuliCard(props: IBuliCardProps): ReactNode {
  // Reasoning remains in the session snapshot but is intentionally not presented yet.
  const text = props.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n")

  return <text fg={theme.text}>{text}</text>
}

export function Transcript(props: ITranscriptProps): ReactNode {
  console.count("Transcript")
  // TODO: Accept the selected session snapshot and render its messages.
  if (props.messages.length === 0) {
    return <text fg={theme.textMuted}>Start converstation</text>
  }

  return (
    <box width="100%" flexDirection="column">
      {props.messages.map((message) => {
        if (message.info.role === "user") {
          return <UserCard key={message.info.id} parts={message.parts} />
        }

        return <BuliCard key={message.info.id} parts={message.parts} />
      })}
    </box>
  )
}
