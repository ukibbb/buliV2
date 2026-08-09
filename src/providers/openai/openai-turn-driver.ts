import type {
  IBuliUserInteractionRequest,
  IInteractionEvent,
  IUserBuliInteractionDriver,
} from "@/engine/interaction-driver"
import type { TextPart } from "@/domain"
import { streamOpenAiText } from "@/providers"
import type { ModelMessage } from "ai"

/** Sends history to OpenAI and converts its stream into Buli events. */
export class OpenAiUserBuliInteractionDriver implements IUserBuliInteractionDriver {
  constructor(
    private readonly streamText: typeof streamOpenAiText = streamOpenAiText,
  ) {}

  async *interaction(
    request: IBuliUserInteractionRequest,
  ): AsyncIterable<IInteractionEvent> {
    const messages: ModelMessage[] = []

    for (const message of request.history) {
      const content = message.parts
        .filter((part): part is TextPart => part.type === "text")
        .map((part) => part.text)
        .join("\n\n")
        .trim()

      if (!content) continue

      messages.push(
        message.info.role === "user"
          ? { role: "user", content }
          : { role: "assistant", content },
      )
    }

    const result = await this.streamText(messages)

    for await (const event of result.stream) {
      switch (event.type) {
        case "text-start":
          yield {
            type: "text-start",
            id: event.id,
          }
          break

        case "text-delta":
          yield {
            type: "text-delta",
            id: event.id,
            delta: event.text,
          }
          break

        case "text-end":
          yield {
            type: "text-end",
            id: event.id,
          }
          break

        case "reasoning-start":
          yield {
            type: "reasoning-start",
            id: event.id,
          }
          break

        case "reasoning-delta":
          yield {
            type: "reasoning-delta",
            id: event.id,
            delta: event.text,
          }
          break

        case "reasoning-end":
          yield {
            type: "reasoning-end",
            id: event.id,
          }
          break

        case "finish":
          yield {
            type: "finish",
            reason: event.rawFinishReason ?? event.finishReason,
          }
          break

        case "abort":
          yield {
            type: "abort",
            ...(event.reason ? { reason: event.reason } : {}),
          }
          break

        case "error":
          yield {
            type: "error",
            error: event.error,
          }
          break

        default:
          break
      }
    }
  }
}
