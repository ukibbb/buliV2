import type { ReactNode } from "react"
import type { IBuliMessageWithParts, Part } from "@/engine/interaction-driver"
import { theme } from "@/tui/theme"

interface ITranscriptProps {
  messages: readonly IBuliMessageWithParts[]
}
interface IUserCardProps {
  id: string
  parts: readonly Part[]
}
function UserCard(props: IUserCardProps): ReactNode {
  const text: string = props.parts
    // map callback Part to string result string[]
    .map((part: Part): string => part.text.trim())
    // filter callback string->boolean result string[]
    .filter((text: string): boolean => text.length > 0)
    .join("\n\n")

  return <text>{text}</text>
}
interface IBuliCardProps {
  parts: readonly Part[]
}
function BuliCard(props: IBuliCardProps): ReactNode {
  const text: string = props.parts
    .filter((part: Part): boolean => part.type === "text")
    .map((part: Part): string => part.text)
    .join("\n\n")

  return <text fg={theme.text}>{text}</text>
}

export function Transcript(props: ITranscriptProps): ReactNode {
  console.count("Transcript")
  // TODO: Accept the selected session snapshot and render its messages.
  if (props.messages.length === 0) return <text fg={theme.textMuted}>Start converstation</text>

  return (<box width="100%" flexDirection="column">
    {props.messages.map((message: IBuliMessageWithParts) => {
      if (message.info.role === "user") {
        return <UserCard
          key={message.info.id}
          id={message.info.id}
          parts={message.parts}
        />
      }

      return <BuliCard
        key={message.info.id}
        parts={message.parts}
      />
    })}

  </box>)
}
