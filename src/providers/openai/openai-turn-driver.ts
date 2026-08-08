import type { IUserBuliInteractionDriver, IBuliUserInteractionRequest, IInteractionEvent, TextPart } from "@/engine/interaction-driver"
import { streamOpenAiText } from "@/providers"
import type { ModelMessage } from "ai"

// TurnDriver in opencode
export class OpenAiUserBuliInteractionDriver implements IUserBuliInteractionDriver {

  async *interaction(request: IBuliUserInteractionRequest): AsyncIterable<IInteractionEvent> {

    console.log("OpenAiUserBuliInteractionriver: interaction", request)

    const messages: ModelMessage[] = []

    for (const message of request.history) {
      // Filter out ReasoningPart
      const content: string = message.parts
        .filter((part): part is TextPart => part.type === "text")
        .map((part: TextPart): string => part.text)
        .join("\n\n")
        .trim()
      if (!content) continue
      messages.push(message.info.role == "user" ? { role: "user", content } : { role: "assistant", content })
    }

    const result = await streamOpenAiText(messages)

    for await (const event of result.stream) {
      switch (event.type) {
        case "text-start": {
          yield {
            type: "text-start",
            id: event.id
          }
          break
        }
        case "text-delta": {
          yield {
            type: "text-delta",
            id: event.id,
            delta: event.text
          }
          break
        }
        case "text-end": {
          yield {
            type: "text-end", id: event.id
          }
          break
        }
        case "reasoning-start":
          yield { type: "reasoning-start", id: event.id }
          break

        case "reasoning-delta":
          yield {
            type: "reasoning-delta",
            id: event.id,
            delta: event.text,
          }
          break

        case "reasoning-end":
          yield { type: "reasoning-end", id: event.id }
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
            error: event.error as Error,
          }
          break

        default:
          break

      }

    }


  }
}
