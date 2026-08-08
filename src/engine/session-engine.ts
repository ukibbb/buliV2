import { SessionViewStore } from "@/engine/session-view-store"
import type { IBuliMessage, Part } from "@/engine/interaction-driver"
import type { IUserBuliInteractionDriver, IBuliMessageWithParts } from "@/engine/interaction-driver"
import type { AIModel } from "@/providers/common-types"

export interface Session {
  id: string
  title: string
  model: AIModel
  createdAt: number
}

export type TPromptPartInput = { type: "text", text: string }

export interface ISessionPromptInput {
  sessionId: string
  parts?: TPromptPartInput[]
}

export interface ISessionEngineOptions {
  driver: IUserBuliInteractionDriver
}

export class SessionEngine {

  private readonly driver: IUserBuliInteractionDriver
  private readonly views = new Map<string, SessionViewStore>

  constructor(options: ISessionEngineOptions) {
    this.driver = options.driver
  }

  view(sessionId: string): SessionViewStore {
    const view = this.views.get(sessionId)
    if (view) return view

    const fresh = new SessionViewStore()

    this.views.set(sessionId, fresh)
    return fresh

  }

  async prompt(input: ISessionPromptInput): Promise<IBuliMessage | undefined> {
    console.log("SessionEngine: prompt: input: ", input)
    // filter empty parts
    const parts = (input.parts ?? []).filter((part: TPromptPartInput): boolean => part.text.trim().length > 0)
    // if we don't have parts
    if (parts.length === 0) return

    const view = this.view(input.sessionId)

    const now: number = Date.now()
    const messageId: string = crypto.randomUUID()

    const message: IBuliMessageWithParts = {
      info: {
        id: messageId,
        sessionId: input.sessionId,
        role: "user",
        createdAt: now
      },
      parts: parts.map(
        (part: TPromptPartInput): Part => ({
          id: crypto.randomUUID(),
          messageId,
          sessionId: input.sessionId,
          createdAt: now,
          type: "text",
          text: part.text
        })
      )
    }


    view.publish(message)
    const history = view.getSnapshot().messages
    console.log("SessionEngine:prompt -> history", history)

    const interaction = this.driver.interaction({
      sessionId: input.sessionId,
      history
    })

    const assistantMessageId = crypto.randomUUID()
    const assistantPartId = crypto.randomUUID()
    const assistantCreatedAt = Date.now()
    let assistantText = ""
    let assistantMessage: IBuliMessage = {
      id: assistantMessageId,
      sessionId: input.sessionId,
      role: "assistant",
      createdAt: assistantCreatedAt
    }

    const publishAssistant = (): void => {
      view.publish({
        info: assistantMessage,
        parts: [{
          id: assistantPartId,
          messageId: assistantMessageId,
          sessionId: input.sessionId,
          createdAt: assistantCreatedAt,
          type: "text",
          text: assistantText
        }]
      })
    }

    for await (const event of interaction) {
      if (event.type === "text-delta") {
        assistantText += event.delta
        publishAssistant()
        continue
      }

      if (event.type === "finish") {
        assistantMessage = {
          ...assistantMessage,
          completedAt: Date.now(),
          finish: event.reason
        }
        publishAssistant()
        return assistantMessage
      }

      if (event.type === "abort") {
        assistantMessage = {
          ...assistantMessage,
          completedAt: Date.now(),
          finish: event.reason ?? "aborted"
        }
        publishAssistant()
        return assistantMessage
      }

      if (event.type === "error") {
        assistantMessage = {
          ...assistantMessage,
          completedAt: Date.now(),
          error: {
            name: event.error.name,
            message: event.error.message
          }
        }
        publishAssistant()
        return assistantMessage
      }
    }

    assistantMessage = {
      ...assistantMessage,
      completedAt: Date.now()
    }
    publishAssistant()
    return assistantMessage
  }
}
