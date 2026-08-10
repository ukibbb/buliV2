import type {
  IBuliMessageWithParts,
  ISessionSnapshot,
  TJsonValue,
} from "@/domain"

export type TSessionStoreListener = () => void

export interface ISessionStore {

  readonly getHistory: (
    sessionId: string,
  ) => readonly IBuliMessageWithParts[]

  readonly getSnapshot: (sessionId: string) => ISessionSnapshot

  readonly publish: (
    message: IBuliMessageWithParts,
  ) => void

  readonly subscribe: (
    sessionId: string,
    listener: TSessionStoreListener,
  ) => () => void

  readonly reset: () => void
}

const EMPTY_SESSION_SNAPSHOT: ISessionSnapshot = Object.freeze({
  messages: Object.freeze([]),
})

/** Stores session messages in memory and notifies listeners when they change. */
export class InMemorySessionStore implements ISessionStore {

  private readonly snapshots = new Map<string, ISessionSnapshot>()
  private readonly listeners = new Map<string, Set<TSessionStoreListener>>()

  readonly getHistory = (
    sessionId: string,
  ): readonly IBuliMessageWithParts[] => {
    return structuredClone(this.getSnapshot(sessionId).messages)
  }


  readonly publish = (
    message: IBuliMessageWithParts,
  ): void => {
    assertValidSessionMessage(message)

    const sessionId = message.info.sessionId
    const current = this.getSnapshot(sessionId).messages
    const lastIndex = current.length - 1

    const index =
      current[lastIndex]?.info.id === message.info.id
        ? lastIndex
        : current.findIndex(
          (item) => item.info.id === message.info.id,
        )

    // Clone and freeze once so engine state and UI consumers cannot mutate storage.
    const stored = freezeMessage(message)
    const messages = [...current]

    if (index === -1) {
      messages.push(stored)
    } else {
      messages[index] = stored
    }

    this.snapshots.set(
      sessionId,
      Object.freeze({ messages: Object.freeze(messages) }),
    )

    const listeners = [...(this.listeners.get(sessionId) ?? [])]
    listeners.forEach((listener) => listener())
  }

  readonly reset = (): void => {
    if (this.snapshots.size === 0) return

    this.snapshots.clear()

    for (const listeners of this.listeners.values()) {
      // Copy because a listener can unsubscribe while callbacks are running.
      for (const listener of [...listeners]) listener()
    }
  }

  readonly getSnapshot = (sessionId: string): ISessionSnapshot => {
    return this.snapshots.get(sessionId) ?? EMPTY_SESSION_SNAPSHOT
  }

  // this methods gets called from outside
  readonly subscribe = (
    sessionId: string,
    listener: TSessionStoreListener,
  ): (() => void) => {
    const listeners = this.listeners.get(sessionId) ?? new Set()
    listeners.add(listener)
    this.listeners.set(sessionId, listeners)

    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(sessionId)
    }
  }

}

const TOOL_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "completed",
  "error",
  "cancelled",
])

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

function freezeMessage(message: IBuliMessageWithParts): IBuliMessageWithParts {
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
