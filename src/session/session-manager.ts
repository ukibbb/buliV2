import type {
  IAssistantMessage,
  ISessionSnapshot,
  TAgentMessage,
} from "@/domain"

export interface ISessionManager {
  readonly getMessages: (sessionId: string) => readonly TAgentMessage[]
  readonly appendMessage: (message: TAgentMessage) => void
  readonly resetSession: (sessionId: string) => void
}

/** Keeps durable messages separate from live Agent state. */
export class InMemorySessionManager implements ISessionManager {
  private readonly messagesBySession = new Map<
    string,
    readonly TAgentMessage[]
  >()

  readonly getMessages = (sessionId: string): readonly TAgentMessage[] => {
    return structuredClone(this.messagesBySession.get(sessionId) ?? [])
  }

  readonly appendMessage = (message: TAgentMessage): void => {
    assertDurableSessionMessage(message)

    const current = this.messagesBySession.get(message.sessionId) ?? []
    const existingIndex = current.findIndex(
      (candidate) => candidate.id === message.id,
    )
    const updated = [...current]

    if (existingIndex === -1) updated.push(structuredClone(message))
    else updated[existingIndex] = structuredClone(message)

    this.messagesBySession.set(message.sessionId, updated)
  }

  readonly resetSession = (sessionId: string): void => {
    this.messagesBySession.delete(sessionId)
  }

  getAllMessages(): readonly TAgentMessage[] {
    return structuredClone([...this.messagesBySession.values()].flat())
  }
}

export function assertDurableSessionMessage(
  value: unknown,
): asserts value is TAgentMessage {
  if (!isMessageBase(value)) throw new Error("Invalid session message")

  switch (value.role) {
    case "user":
      if (typeof value.content !== "string") {
        throw new Error("Invalid user message")
      }
      return
    case "assistant":
      assertAssistantMessage(value)
      if (value.stopReason === "pending") {
        throw new Error("Cannot persist an incomplete assistant message")
      }
      return
    case "toolResult":
      if (
        typeof value.toolCallId !== "string"
        || typeof value.toolName !== "string"
        || typeof value.content !== "string"
        || typeof value.isError !== "boolean"
      ) {
        throw new Error("Invalid tool result message")
      }
      return
    default:
      throw new Error("Unknown session message role")
  }
}

export function freezeSessionSnapshot(
  snapshot: ISessionSnapshot,
): ISessionSnapshot {
  const clone = structuredClone(snapshot)
  deepFreeze(clone)
  return clone
}

function assertAssistantMessage(
  message: Record<string, unknown>,
): asserts message is Record<string, unknown> & IAssistantMessage {
  if (!Array.isArray(message.content) || typeof message.stopReason !== "string") {
    throw new Error("Invalid assistant message")
  }
  if (
    message.errorMessage !== undefined
    && typeof message.errorMessage !== "string"
  ) {
    throw new Error("Invalid assistant error")
  }

  for (const content of message.content) {
    if (!isRecord(content)) throw new Error("Invalid assistant content")
    if (content.type === "text" || content.type === "reasoning") {
      if (typeof content.text !== "string") {
        throw new Error("Invalid assistant text content")
      }
      continue
    }
    if (
      content.type !== "toolCall"
      || typeof content.toolCallId !== "string"
      || typeof content.toolName !== "string"
      || !isRecord(content.input)
    ) {
      throw new Error("Invalid assistant tool call")
    }
  }
}

function isMessageBase(value: unknown): value is Record<string, unknown> & {
  readonly id: string
  readonly sessionId: string
  readonly role: string
  readonly createdAt: number
} {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.sessionId === "string"
    && typeof value.role === "string"
    && typeof value.createdAt === "number"
    && Number.isFinite(value.createdAt)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object") return
  for (const child of Object.values(value)) deepFreeze(child)
  Object.freeze(value)
}
