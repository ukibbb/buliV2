import type { ReactNode } from "react"
import type {
  IBuliMessage,
  IBuliMessageWithParts,
  ITextPart,
  IToolPart,
  TPart,
  TToolStatus,
} from "@/domain"
import { syntax, theme } from "@/tui/theme"

const TOOL_LINE_MAX_CHARACTERS = 160

const toolStatusLabels: Record<TToolStatus, string> = {
  pending: "pending",
  running: "running",
  completed: "done",
  error: "error",
  cancelled: "cancelled",
}

interface ITranscriptProps {
  messages: readonly IBuliMessageWithParts[]
}

interface IUserCardProps {
  parts: readonly TPart[]
}

function UserCard(props: IUserCardProps): ReactNode {
  const text = props.parts
    .filter((part): part is ITextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter((partText) => partText.length > 0)
    .join("\n\n")

  return <text margin={1}>{text}</text>
}
interface IBuliCardProps {
  parts: readonly TPart[]
  error: IBuliMessage["error"]
  complete: boolean
}

function BuliCard(props: IBuliCardProps): ReactNode {
  return (
    <box width="100%" flexDirection="column">
      {props.parts.map((part) => {
        if (part.type === "text") {
          return <markdown
            key={part.id}
            fg={theme.text}
            content={part.text}
            syntaxStyle={syntax}
            streaming={!props.complete}
            conceal
          />
        }

        if (part.type === "tool") {
          return <ToolLine key={part.id} part={part} />
        }

        // Reasoning remains in the session snapshot but is intentionally hidden.
        return null
      })}
      {props.error
        ? <text fg={theme.red}>{`${props.error.name}: ${props.error.message}`}</text>
        : null}
    </box>
  )
}

function ToolLine(props: { part: IToolPart }): ReactNode {
  const input = JSON.stringify(props.part.input)
  const error = props.part.error ? `: ${props.part.error}` : ""
  const line = compactText(
    `[${toolStatusLabels[props.part.status]}] ${props.part.tool} ${input}${error}`,
    TOOL_LINE_MAX_CHARACTERS,
  )
  const color = props.part.status === "error" || props.part.status === "cancelled"
    ? theme.red
    : props.part.status === "running" || props.part.status === "pending"
      ? theme.amber
      : theme.textMuted

  return <text fg={color} wrapMode="word">{line}</text>
}

function compactText(value: string, maximumCharacters: number): string {
  if (value.length <= maximumCharacters) return value
  return `${value.slice(0, maximumCharacters - 3)}...`
}

export function Transcript(props: ITranscriptProps): ReactNode {
  console.count("Transcript")
  if (props.messages.length === 0) {
    return <text fg={theme.textMuted}>Start converstation</text>
  }

  return (
    <box width="100%" flexDirection="column">
      {props.messages.map((message) => {
        if (message.info.role === "user") {
          return <UserCard key={message.info.id} parts={message.parts} />
        }

        return (
          <BuliCard
            key={message.info.id}
            parts={message.parts}
            error={message.info.error}
            complete={message.info.completedAt !== undefined}
          />
        )
      })}
    </box>
  )
}
