import type {
  IBuliMessageWithParts,
  ISessionSnapshot,
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

  readonly getSnapshot = (sessionId: string): ISessionSnapshot => {
    return this.snapshots.get(sessionId) ?? EMPTY_SESSION_SNAPSHOT
  }

  readonly publish = (
    message: IBuliMessageWithParts,
  ): void => {
    this.validateMessage(message)

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

  private validateMessage(
    message: IBuliMessageWithParts,
  ): void {
    for (const part of message.parts) {
      if (part.sessionId !== message.info.sessionId) {
        throw new Error(
          `Part ${part.id} belongs to another session`,
        )
      }

      if (part.messageId !== message.info.id) {
        throw new Error(
          `Part ${part.id} belongs to another message`,
        )
      }
    }
  }
}

function freezeMessage(message: IBuliMessageWithParts): IBuliMessageWithParts {
  const clone = structuredClone(message)

  if (clone.info.role === "assistant" && clone.info.error) {
    Object.freeze(clone.info.error)
  }

  Object.freeze(clone.info)
  clone.parts.forEach((part) => Object.freeze(part))
  Object.freeze(clone.parts)
  return Object.freeze(clone)
}
