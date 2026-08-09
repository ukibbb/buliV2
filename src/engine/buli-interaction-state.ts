import type { IInteractionEvent } from "@/engine/interaction-driver"
import { generateRandomId } from "@/common"
import type {
  IBuliMessage,
  IBuliMessageWithParts,
  Part,
  ReasoningPart,
  TextPart,
} from "@/domain"

interface IBuliInteractionStateOptions {
  sessionId: string
  now: () => number
  publish: (message: IBuliMessageWithParts) => void
}

interface IInteractionError {
  name: string
  message: string
}

/** Builds one Buli message from streamed provider events. */
export class BuliInteractionState {
  private message: IBuliMessage
  private readonly parts: Part[] = []
  private readonly textParts = new Map<string, TextPart>()
  private readonly reasoningParts = new Map<string, ReasoningPart>()
  private finished = false


  constructor(private readonly options: IBuliInteractionStateOptions) {
    this.message = {
      id: generateRandomId(),
      sessionId: options.sessionId,
      role: "assistant",
      createdAt: options.now(),
    }
  }

  get completed(): boolean {
    return this.finished
  }

  apply(event: IInteractionEvent): void {
    if (this.finished) return

    switch (event.type) {
      case "text-start":
        this.startText(event.id)
        return

      case "text-delta":
        this.appendText(event.id, event.delta)
        return

      case "text-end":
        this.textParts.delete(event.id)
        return

      case "reasoning-start":
        this.startReasoning(event.id)
        return

      case "reasoning-delta":
        this.appendReasoning(event.id, event.delta)
        return

      case "reasoning-end":
        this.reasoningParts.delete(event.id)
        return

      case "finish":
        this.complete(event.reason)
        return

      case "abort":
        this.failWith(
          {
            name: "AbortError",
            message: event.reason ?? "Buli interaction was aborted",
          },
          "abort",
        )
        return

      case "error":
        this.fail(event.error)
        return
    }
  }

  complete(reason = "stop"): IBuliMessage {
    if (!this.finished) {
      this.finished = true
      this.clearOpenParts()

      this.message = {
        ...this.message,
        completedAt: this.options.now(),
        finish: reason,
      }

      this.publish()
    }

    return structuredClone(this.message)
  }

  fail(value: unknown): IBuliMessage {
    return this.failWith(normalizeError(value), "error")
  }

  private startText(driverId: string): void {
    if (this.textParts.has(driverId)) return

    const part: TextPart = {
      id: generateRandomId(),
      messageId: this.message.id,
      sessionId: this.message.sessionId,
      createdAt: this.options.now(),
      type: "text",
      text: "",
    }

    this.textParts.set(driverId, part)
    this.parts.push(part)
    this.publish()
  }

  private appendText(driverId: string, delta: string): void {
    const current = this.textParts.get(driverId)
    if (!current) return

    const updated: TextPart = {
      ...current,
      text: current.text + delta,
    }

    this.textParts.set(driverId, updated)
    this.replacePart(updated)
    this.publish()
  }

  private startReasoning(driverId: string): void {
    if (this.reasoningParts.has(driverId)) return

    const part: ReasoningPart = {
      id: generateRandomId(),
      messageId: this.message.id,
      sessionId: this.message.sessionId,
      createdAt: this.options.now(),
      type: "reasoning",
      text: "",
    }

    this.reasoningParts.set(driverId, part)
    this.parts.push(part)
    this.publish()
  }

  private appendReasoning(driverId: string, delta: string): void {
    const current = this.reasoningParts.get(driverId)
    if (!current) return

    const updated: ReasoningPart = {
      ...current,
      text: current.text + delta,
    }

    this.reasoningParts.set(driverId, updated)
    this.replacePart(updated)
    this.publish()
  }

  private replacePart(part: Part): void {
    const index = this.parts.findIndex((candidate) => candidate.id === part.id)
    if (index === -1) return
    this.parts[index] = part
  }

  private failWith(error: IInteractionError, finish: string): IBuliMessage {
    if (!this.finished) {
      this.finished = true
      this.clearOpenParts()

      this.message = {
        ...this.message,
        completedAt: this.options.now(),
        finish,
        error,
      }

      this.publish()
    }

    return structuredClone(this.message)
  }

  private clearOpenParts(): void {
    this.textParts.clear()
    this.reasoningParts.clear()
  }

  private publish(): void {
    // The store clones synchronously, so this reducer can keep its working arrays.
    this.options.publish({
      info: this.message,
      parts: this.parts,
    })
  }
}

function normalizeError(value: unknown): IInteractionError {
  if (value instanceof Error) {
    return {
      name: value.name || "Error",
      message: value.message,
    }
  }

  return {
    name: "Error",
    message: String(value),
  }
}
