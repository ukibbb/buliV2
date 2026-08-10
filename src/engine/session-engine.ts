import { BuliIterationState } from "@/engine/buli-iteration-state"
import { generateRandomId } from "@/common"
import type {
  IBuliMessage,
  IBuliMessageWithParts,
  TPart,
} from "@/domain"
import type { IUserBuliInteractionDriver } from "@/engine/interaction-driver"
import {
  InMemorySessionStore,
  type ISessionStore,
} from "@/engine/session-store"

const MAX_PROVIDER_ITERATIONS = 5

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
  private readonly activePrompts = new Map<string, AbortController>()

  constructor(options: ISessionEngineOptions) {
    this.driver = options.driver
    this.store = options.store ?? new InMemorySessionStore()
    this.now = options.now ?? Date.now
  }

  async prompt(input: ISessionPromptInput): Promise<IBuliMessage | undefined> {
    const parts = (input.parts ?? []).filter(
      (part) => part.text.trim().length > 0,
    )

    if (parts.length === 0) return undefined
    if (this.activePrompts.has(input.sessionId)) {
      throw new Error(`A prompt is already running for session ${input.sessionId}`)
    }

    const userMessage = this.createUserMessage(input.sessionId, parts)
    const controller = new AbortController()
    this.activePrompts.set(input.sessionId, controller)

    try {
      this.store.publish(userMessage)
      let latestAssistant: IBuliMessage | undefined

      for (
        let iteration = 0;
        iteration < MAX_PROVIDER_ITERATIONS;
        iteration += 1
      ) {
        const iterationState = new BuliIterationState({
          sessionId: input.sessionId,
          now: this.now,
          publish: (message: IBuliMessageWithParts) => this.store.publish(message),
        })

        try {
          const interaction = this.driver.interaction({
            sessionId: input.sessionId,
            history: this.store.getHistory(input.sessionId),
            signal: controller.signal,
          })

          for await (const event of interaction) {
            iterationState.apply(event)
            if (iterationState.completed) break
          }

          if (controller.signal.aborted && !iterationState.completed) {
            iterationState.apply({
              type: "abort",
              reason: "Buli interaction was aborted",
            })
          }

          const outcome = iterationState.complete()
          latestAssistant = outcome.assistant

          if (!outcome.shouldContinue) return latestAssistant
        } catch (error) {
          if (controller.signal.aborted) {
            iterationState.apply({
              type: "abort",
              reason: "Buli interaction was aborted",
            })
            return iterationState.complete().assistant
          }

          return iterationState.fail(error).assistant
        }
      }

      return latestAssistant
    } finally {
      if (this.activePrompts.get(input.sessionId) === controller) {
        this.activePrompts.delete(input.sessionId)
      }
    }
  }

  abort(sessionId: string): void {
    this.activePrompts.get(sessionId)?.abort("Buli interaction was aborted")
  }

  reset(): void {
    if (this.activePrompts.size > 0) {
      throw new Error("Cannot reset while a prompt is running")
    }
    this.store.reset()
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
        (part): TPart => ({
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
