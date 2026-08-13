import type { ReactNode } from "react"

import type {
  IAssistantMessage,
  IToolCallContent,
  IToolResultMessage,
  TAgentMessage,
} from "@/domain"
import { syntax, theme } from "@/tui/theme"

const TOOL_LINE_MAX_CHARACTERS = 160

interface ITranscriptProps {
  readonly messages: readonly TAgentMessage[]
  readonly streamingMessage?: IAssistantMessage
  readonly pendingToolCallIds?: readonly string[]
}

function AssistantCard(props: {
  readonly message: IAssistantMessage
  readonly streaming: boolean
  readonly pendingToolCallIds: ReadonlySet<string>
}): ReactNode {
  return (
    <box width="100%" flexDirection="column">
      {props.message.content.map((content, index) => {
        if (content.type === "text") {
          return <markdown
            key={`${props.message.id}-text-${index}`}
            fg={theme.text}
            content={content.text}
            syntaxStyle={syntax}
            streaming={props.streaming}
            conceal
          />
        }

        if (content.type === "toolCall") {
          return <ToolCallLine
            key={content.toolCallId}
            call={content}
            running={props.pendingToolCallIds.has(content.toolCallId)}
          />
        }

        return null
      })}
      {props.message.errorMessage
        ? <text fg={theme.red}>{props.message.errorMessage}</text>
        : null}
    </box>
  )
}

function ToolCallLine(props: {
  readonly call: IToolCallContent
  readonly running: boolean
}): ReactNode {
  const status = props.running ? "running" : "call"
  const line = compactText(
    `[${status}] ${props.call.toolName} ${JSON.stringify(props.call.input)}`,
    TOOL_LINE_MAX_CHARACTERS,
  )
  return <text fg={props.running ? theme.amber : theme.textMuted}>{line}</text>
}

function ToolResultLine(props: { readonly message: IToolResultMessage }): ReactNode {
  const status = props.message.isError ? "error" : "done"
  const detail = props.message.isError ? `: ${props.message.content}` : ""
  const line = compactText(
    `[${status}] ${props.message.toolName}${detail}`,
    TOOL_LINE_MAX_CHARACTERS,
  )
  return <text fg={props.message.isError ? theme.red : theme.textMuted}>{line}</text>
}

function compactText(value: string, maximumCharacters: number): string {
  if (value.length <= maximumCharacters) return value
  return `${value.slice(0, maximumCharacters - 3)}...`
}

export function Transcript(props: ITranscriptProps): ReactNode {
  if (props.messages.length === 0 && !props.streamingMessage) {
    return <text fg={theme.textMuted}>Start conversation</text>
  }

  const pendingToolCallIds = new Set(props.pendingToolCallIds ?? [])
  return (
    <box width="100%" flexDirection="column">
      {props.messages.map((message) => {
        switch (message.role) {
          case "user":
            return <text key={message.id} margin={1}>{message.content.trim()}</text>
          case "assistant":
            return <AssistantCard
              key={message.id}
              message={message}
              streaming={false}
              pendingToolCallIds={pendingToolCallIds}
            />
          case "toolResult":
            return <ToolResultLine key={message.id} message={message} />
        }
      })}
      {props.streamingMessage
        ? <AssistantCard
            message={props.streamingMessage}
            streaming
            pendingToolCallIds={pendingToolCallIds}
          />
        : null}
    </box>
  )
}
