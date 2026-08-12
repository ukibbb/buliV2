import type {
  IBuliMessageWithParts,
  ISessionSnapshot,
  TJsonValue,
} from "@/domain"

export interface ISessionManager {
  readonly getMessages: (
    sessionId: string,
  ) => readonly IBuliMessageWithParts[]
  readonly appendMessage: (message: IBuliMessageWithParts) => void
  readonly resetSession: (sessionId: string) => void
}

/** Keeps durable session messages separate from live Agent state. */
export class InMemorySessionManager implements ISessionManager {
  private readonly messagesBySession = new Map<
    string,
    readonly IBuliMessageWithParts[]
  >()

  readonly getMessages = (
    sessionId: string,
  ): readonly IBuliMessageWithParts[] => {
    return structuredClone(this.messagesBySession.get(sessionId) ?? [])
  }

  readonly appendMessage = (message: IBuliMessageWithParts): void => {
    assertDurableSessionMessage(message)

    const sessionId = message.info.sessionId
    const current = this.messagesBySession.get(sessionId) ?? []
    const existingIndex = current.findIndex(
      (candidate) => candidate.info.id === message.info.id,
    )
    const stored = freezeMessage(message)
    const updated = [...current]

    if (existingIndex === -1) updated.push(stored)
    else updated[existingIndex] = stored

    this.messagesBySession.set(sessionId, Object.freeze(updated))
  }

  readonly resetSession = (sessionId: string): void => {
    this.messagesBySession.delete(sessionId)
  }

  getAllMessages(): readonly IBuliMessageWithParts[] {
    return structuredClone([...this.messagesBySession.values()].flat())
  }
}

export function assertDurableSessionMessage(
  value: unknown,
): asserts value is IBuliMessageWithParts {
  assertValidSessionMessage(value)
  if (value.info.role === "assistant" && value.info.completedAt === undefined) {
    throw new Error("Cannot persist an incomplete assistant message")
  }
}

export function assertValidSessionMessage(
  value: unknown,
): asserts value is IBuliMessageWithParts {
  if (!isRecord(value) || !isRecord(value.info) || !Array.isArray(value.parts)) {
    throw new Error("Invalid session message structure")
  }

  const info = value.info
  if (
    typeof info.id !== "string"
    || typeof info.sessionId !== "string"
    || (info.role !== "user" && info.role !== "assistant")
    || !isFiniteNumber(info.createdAt)
  ) {
    throw new Error("Invalid session message info")
  }

  if (info.role === "assistant") {
    if (info.completedAt !== undefined && !isFiniteNumber(info.completedAt)) {
      throw new Error("Invalid assistant completion time")
    }
    if (info.finish !== undefined && typeof info.finish !== "string") {
      throw new Error("Invalid assistant finish reason")
    }
    if (info.error !== undefined) {
      if (
        !isRecord(info.error)
        || typeof info.error.name !== "string"
        || typeof info.error.message !== "string"
      ) {
        throw new Error("Invalid assistant error")
      }
    }
  }

  for (const candidate of value.parts) {
    if (
      !isRecord(candidate)
      || typeof candidate.id !== "string"
      || typeof candidate.messageId !== "string"
      || typeof candidate.sessionId !== "string"
      || !isFiniteNumber(candidate.createdAt)
    ) {
      throw new Error("Invalid session message part")
    }

    if (candidate.sessionId !== info.sessionId) {
      throw new Error(`Part ${candidate.id} belongs to another session`)
    }
    if (candidate.messageId !== info.id) {
      throw new Error(`Part ${candidate.id} belongs to another message`)
    }

    if (candidate.type === "text" || candidate.type === "reasoning") {
      if (typeof candidate.text !== "string") {
        throw new Error(`Part ${candidate.id} has invalid text`)
      }
      continue
    }

    if (candidate.type !== "tool") {
      throw new Error(`Part ${candidate.id} has an unknown type`)
    }
    if (
      typeof candidate.callID !== "string"
      || typeof candidate.tool !== "string"
      || typeof candidate.status !== "string"
      || !TOOL_STATUSES.has(candidate.status)
      || !isRecord(candidate.input)
      || !isJsonValue(candidate.input)
      || (candidate.execution !== "local" && candidate.execution !== "provider")
    ) {
      throw new Error(`Part ${candidate.id} has invalid tool data`)
    }
    if (candidate.output !== undefined && !isJsonValue(candidate.output)) {
      throw new Error(`Part ${candidate.id} has invalid tool output`)
    }
    if (candidate.error !== undefined && typeof candidate.error !== "string") {
      throw new Error(`Part ${candidate.id} has invalid tool error`)
    }
    if (candidate.startedAt !== undefined && !isFiniteNumber(candidate.startedAt)) {
      throw new Error(`Part ${candidate.id} has invalid tool start time`)
    }
    if (
      candidate.completedAt !== undefined
      && !isFiniteNumber(candidate.completedAt)
    ) {
      throw new Error(`Part ${candidate.id} has invalid tool completion time`)
    }
  }
}

export function freezeSessionSnapshot(
  snapshot: ISessionSnapshot,
): ISessionSnapshot {
  const messages = snapshot.messages.map(freezeMessage)
  return Object.freeze({
    ...snapshot,
    messages: Object.freeze(messages),
    pendingToolCallIDs: Object.freeze([...snapshot.pendingToolCallIDs]),
  })
}

const TOOL_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "completed",
  "error",
  "cancelled",
])

function freezeMessage(
  message: IBuliMessageWithParts,
): IBuliMessageWithParts {
  const clone = structuredClone(message)

  if (clone.info.role === "assistant" && clone.info.error) {
    Object.freeze(clone.info.error)
  }
  Object.freeze(clone.info)

  clone.parts.forEach((part) => {
    if (part.type === "tool") {
      freezeJsonValue(part.input)
      if (part.output !== undefined) freezeJsonValue(part.output)
    }
    Object.freeze(part)
  })
  Object.freeze(clone.parts)
  return Object.freeze(clone)
}

function freezeJsonValue(value: TJsonValue): void {
  if (Array.isArray(value)) {
    value.forEach(freezeJsonValue)
    Object.freeze(value)
    return
  }
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freezeJsonValue)
    Object.freeze(value)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isJsonValue(value: unknown): value is TJsonValue {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || isFiniteNumber(value)
  ) {
    return true
  }
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (!isRecord(value)) return false
  return Object.values(value).every(isJsonValue)
}
