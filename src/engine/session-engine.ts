import { BuliInteractionState } from "@/engine/buli-interaction-state"
import { generateRandomId } from "@/common"
import type {
  IBuliMessage,
  IBuliMessageWithParts,
  Part,
} from "@/domain"
import type { IUserBuliInteractionDriver } from "@/engine/interaction-driver"
import {
  InMemorySessionStore,
  type ISessionStore,
} from "@/engine/session-store"
export type TPromptPartInput = {
  readonly type: "text"
  readonly text: string
}

export interface ISessionPromptInput {
  readonly sessionId: string
  readonly parts?: readonly TPromptPartInput[]
}

export interface ISessionEngineOptions {
  driver: IUserBuliInteractionDriver
  store?: ISessionStore
  now?: () => number
}

/** Saves a user prompt and runs Buli's response. */
export class SessionEngine {
  readonly store: ISessionStore

  private readonly driver: IUserBuliInteractionDriver
  private readonly now: () => number

  constructor(options: ISessionEngineOptions) {
    this.driver = options.driver
    this.store = options.store ?? new InMemorySessionStore()
    this.now = options.now ?? Date.now
  }

  // TODO: Concurrent prompts for one session can interleave history and replies.
  // Choose an explicit policy before enabling them: reject, queue, or abort-and-replace.
  async prompt(input: ISessionPromptInput): Promise<IBuliMessage | undefined> {
    const parts = (input.parts ?? []).filter(
      (part) => part.text.trim().length > 0,
    )

    if (parts.length === 0) return undefined

    const userMessage = this.createUserMessage(input.sessionId, parts)
    this.store.publish(userMessage)

    const interactionState = new BuliInteractionState({
      sessionId: input.sessionId,
      now: this.now,
      publish: (message) => this.store.publish(message),
    })

    try {
      const interaction = this.driver.interaction({
        sessionId: input.sessionId,
        history: this.store.getHistory(input.sessionId),
      })

      for await (const event of interaction) {
        interactionState.apply(event)
        if (interactionState.completed) break
      }

      return interactionState.complete()
    } catch (error) {
      return interactionState.fail(error)
    }
  }

  private createUserMessage(
    sessionId: string,
    parts: readonly TPromptPartInput[],
  ): IBuliMessageWithParts {
    const messageId = generateRandomId()
    const createdAt = this.now()

    return {
      info: {
        id: messageId,
        sessionId,
        role: "user",
        createdAt,
      },
      parts: parts.map(
        (part): Part => ({
          id: generateRandomId(),
          messageId,
          sessionId,
          createdAt,
          type: "text",
          text: part.text,
        }),
      ),
    }
  }
}
