import type { IInteractionEvent } from "@/engine/interaction-driver"
import { generateRandomId } from "@/common"
import type {
  IBuliMessage,
  IBuliMessageWithParts,
  IReasoningPart,
  ITextPart,
  IToolPart,
  TPart,
} from "@/domain"

interface IBuliIterationStateOptions {
  sessionId: string
  now: () => number
  publish: (message: IBuliMessageWithParts) => void
}

export interface IBuliIterationOutcome {
  readonly assistant: IBuliMessage
  readonly shouldContinue: boolean
}

interface IInteractionError {
  name: string
  message: string
}

/** Builds one Buli message from one streamed provider iteration. */
export class BuliIterationState {
  private message: IBuliMessage
  private readonly parts: TPart[] = []
  private readonly textParts = new Map<string, ITextPart>()
  private readonly reasoningParts = new Map<string, IReasoningPart>()
  private readonly toolParts = new Map<string, IToolPart>()
  private localToolSettled = false
  private continueAfterCompletion = false
  private finished = false

  constructor(private readonly options: IBuliIterationStateOptions) {
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

      case "tool-call":
        this.startTool(event)
        return

      case "tool-result":
        this.completeTool(event)
        return

      case "tool-error":
        this.failTool(event)
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

  complete(reason = "stop"): IBuliIterationOutcome {
    if (!this.finished) {
      this.finishOpenTools(
        "error",
        "Tool did not finish before the interaction completed",
      )
      this.continueAfterCompletion = this.localToolSettled
      this.finished = true
      this.clearOpenParts()

      this.message = {
        ...this.message,
        completedAt: this.options.now(),
        finish: reason,
      }

      this.publish()
    }

    return this.outcome()
  }

  fail(value: unknown): IBuliIterationOutcome {
    return this.failWith(normalizeError(value), "error")
  }

  private startText(driverId: string): void {
    if (this.textParts.has(driverId)) return

    const part: ITextPart = {
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

    const updated: ITextPart = {
      ...current,
      text: current.text + delta,
    }

    this.textParts.set(driverId, updated)
    this.replacePart(updated)
    this.publish()
  }

  private startReasoning(driverId: string): void {
    if (this.reasoningParts.has(driverId)) return

    const part: IReasoningPart = {
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

    const updated: IReasoningPart = {
      ...current,
      text: current.text + delta,
    }

    this.reasoningParts.set(driverId, updated)
    this.replacePart(updated)
    this.publish()
  }

  private startTool(
    event: Extract<IInteractionEvent, { type: "tool-call" }>,
  ): void {
    if (this.toolParts.has(event.callID)) return

    const startedAt = this.options.now()
    const part: IToolPart = {
      id: generateRandomId(),
      messageId: this.message.id,
      sessionId: this.message.sessionId,
      createdAt: startedAt,
      type: "tool",
      callID: event.callID,
      tool: event.tool,
      status: "running",
      input: event.input,
      execution: event.execution,
      startedAt,
    }

    this.toolParts.set(event.callID, part)
    this.parts.push(part)
    this.publish()
  }

  private completeTool(
    event: Extract<IInteractionEvent, { type: "tool-result" }>,
  ): void {
    const current = this.toolParts.get(event.callID)
    if (!current) return

    const completed: IToolPart = {
      ...current,
      tool: event.tool,
      status: "completed",
      input: event.input,
      output: event.output,
      execution: event.execution,
      completedAt: this.options.now(),
    }

    this.toolParts.delete(event.callID)
    this.replacePart(completed)
    if (event.execution === "local") this.localToolSettled = true
    this.publish()
  }

  private failTool(
    event: Extract<IInteractionEvent, { type: "tool-error" }>,
  ): void {
    const current = this.toolParts.get(event.callID)
    if (!current) return

    const failed: IToolPart = {
      ...current,
      tool: event.tool,
      status: "error",
      input: event.input,
      error: event.error,
      execution: event.execution,
      completedAt: this.options.now(),
    }

    this.toolParts.delete(event.callID)
    this.replacePart(failed)
    if (event.execution === "local") this.localToolSettled = true
    this.publish()
  }

  private finishOpenTools(
    status: "error" | "cancelled",
    error: string,
  ): void {
    for (const [callID, current] of this.toolParts) {
      this.replacePart({
        ...current,
        status,
        error,
        completedAt: this.options.now(),
      })
      this.toolParts.delete(callID)
    }
  }

  private replacePart(part: TPart): void {
    const index = this.parts.findIndex((candidate) => candidate.id === part.id)
    if (index === -1) return
    this.parts[index] = part
  }

  private failWith(
    error: IInteractionError,
    finish: string,
  ): IBuliIterationOutcome {
    if (!this.finished) {
      this.finishOpenTools(
        finish === "abort" ? "cancelled" : "error",
        error.message,
      )
      this.continueAfterCompletion = false
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

    return this.outcome()
  }

  private outcome(): IBuliIterationOutcome {
    return {
      assistant: structuredClone(this.message),
      shouldContinue: this.continueAfterCompletion,
    }
  }

  private clearOpenParts(): void {
    this.textParts.clear()
    this.reasoningParts.clear()
    this.toolParts.clear()
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
