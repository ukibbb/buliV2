import type {
  IBuliMessage,
  IBuliMessageWithParts,
  IReasoningPart,
  ITextPart,
  IToolPart,
  TJsonObject,
  TJsonValue,
  TPart,
  TToolExecutionLocation,
} from "@/domain"
import type { IAgentModelEvent } from "@/agent/agent-types"

interface IAssistantMessageBuilderOptions {
  readonly sessionId: string
  readonly now: () => number
  readonly generateId: () => string
}

/** Reduces one provider stream into one assistant message. */
export class AssistantMessageBuilder {
  private message: IBuliMessage
  private readonly parts: TPart[] = []
  private readonly textParts = new Map<string, ITextPart>()
  private readonly reasoningParts = new Map<string, IReasoningPart>()
  private readonly toolParts = new Map<string, IToolPart>()
  private providerFinishReason = "stop"
  private finished = false

  constructor(private readonly options: IAssistantMessageBuilderOptions) {
    this.message = {
      id: options.generateId(),
      sessionId: options.sessionId,
      role: "assistant",
      createdAt: options.now(),
    }
  }

  get completed(): boolean {
    return this.finished
  }

  applyModelEvent(event: IAgentModelEvent): boolean {
    if (this.finished) return false

    switch (event.type) {
      case "text-start":
        this.startText(event.id)
        return true
      case "text-delta":
        this.appendText(event.id, event.delta)
        return true
      case "text-end":
        this.textParts.delete(event.id)
        return true
      case "reasoning-start":
        this.startReasoning(event.id)
        return true
      case "reasoning-delta":
        this.appendReasoning(event.id, event.delta)
        return true
      case "reasoning-end":
        this.reasoningParts.delete(event.id)
        return true
      case "tool-call":
        this.startTool(
          event.callID,
          event.tool,
          event.input,
          event.execution,
        )
        return true
      case "tool-result":
        this.completeTool(event.callID, event.input, event.output)
        return true
      case "tool-error":
        this.failTool(event.callID, event.input, event.error)
        return true
      case "finish":
        this.providerFinishReason = event.reason
        return false
      case "abort":
        this.completeAborted(event.reason ?? "Buli interaction was aborted")
        return false
      case "error":
        this.completeFailed(event.error)
        return false
    }
  }

  pendingLocalTools(): readonly IToolPart[] {
    return this.parts
      .filter(
        (part): part is IToolPart => part.type === "tool"
          && part.execution === "local"
          && (part.status === "pending" || part.status === "running"),
      )
      .map((part) => structuredClone(part))
  }

  markToolRunning(callID: string): void {
    const current = this.toolParts.get(callID)
    if (!current || current.status !== "pending") return

    const running: IToolPart = {
      ...current,
      status: "running",
      startedAt: this.options.now(),
    }
    this.toolParts.set(callID, running)
    this.replacePart(running)
  }

  completeTool(
    callID: string,
    input: TJsonObject,
    output: TJsonValue,
  ): void {
    const current = this.toolParts.get(callID)
    if (!current) return

    const completed: IToolPart = {
      ...current,
      status: "completed",
      input: structuredClone(input),
      output: structuredClone(output),
      startedAt: current.startedAt ?? this.options.now(),
      completedAt: this.options.now(),
    }
    this.toolParts.delete(callID)
    this.replacePart(completed)
  }

  failTool(callID: string, input: TJsonObject, error: string): void {
    this.settleTool(callID, "error", input, error)
  }

  cancelTool(callID: string, input: TJsonObject, error: string): void {
    this.settleTool(callID, "cancelled", input, error)
  }

  completeNormally(): IBuliMessageWithParts {
    if (!this.finished) {
      this.finishOpenTools(
        "error",
        "Tool did not finish before the interaction completed",
      )
      this.finish(this.providerFinishReason)
    }
    return this.snapshot()
  }

  completeAborted(reason: string): IBuliMessageWithParts {
    if (!this.finished) {
      this.finishOpenTools("cancelled", reason)
      this.finish("abort", { name: "AbortError", message: reason })
    }
    return this.snapshot()
  }

  completeFailed(error: unknown): IBuliMessageWithParts {
    if (!this.finished) {
      const normalized = normalizeError(error)
      this.finishOpenTools("error", normalized.message)
      this.finish("error", normalized)
    }
    return this.snapshot()
  }

  snapshot(): IBuliMessageWithParts {
    return structuredClone({ info: this.message, parts: this.parts })
  }

  private startText(driverId: string): void {
    if (this.textParts.has(driverId)) return

    const part: ITextPart = {
      id: this.options.generateId(),
      messageId: this.message.id,
      sessionId: this.message.sessionId,
      createdAt: this.options.now(),
      type: "text",
      text: "",
    }
    this.textParts.set(driverId, part)
    this.parts.push(part)
  }

  private appendText(driverId: string, delta: string): void {
    const current = this.textParts.get(driverId)
    if (!current) return

    const updated: ITextPart = { ...current, text: current.text + delta }
    this.textParts.set(driverId, updated)
    this.replacePart(updated)
  }

  private startReasoning(driverId: string): void {
    if (this.reasoningParts.has(driverId)) return

    const part: IReasoningPart = {
      id: this.options.generateId(),
      messageId: this.message.id,
      sessionId: this.message.sessionId,
      createdAt: this.options.now(),
      type: "reasoning",
      text: "",
    }
    this.reasoningParts.set(driverId, part)
    this.parts.push(part)
  }

  private appendReasoning(driverId: string, delta: string): void {
    const current = this.reasoningParts.get(driverId)
    if (!current) return

    const updated: IReasoningPart = { ...current, text: current.text + delta }
    this.reasoningParts.set(driverId, updated)
    this.replacePart(updated)
  }

  private startTool(
    callID: string,
    tool: string,
    input: TJsonObject,
    execution: TToolExecutionLocation,
  ): void {
    if (this.toolParts.has(callID)) return

    const part: IToolPart = {
      id: this.options.generateId(),
      messageId: this.message.id,
      sessionId: this.message.sessionId,
      createdAt: this.options.now(),
      type: "tool",
      callID,
      tool,
      status: "pending",
      input: structuredClone(input),
      execution,
    }
    this.toolParts.set(callID, part)
    this.parts.push(part)
  }

  private settleTool(
    callID: string,
    status: "error" | "cancelled",
    input: TJsonObject,
    error: string,
  ): void {
    const current = this.toolParts.get(callID)
    if (!current) return

    const settled: IToolPart = {
      ...current,
      status,
      input: structuredClone(input),
      error,
      startedAt: current.startedAt ?? this.options.now(),
      completedAt: this.options.now(),
    }
    this.toolParts.delete(callID)
    this.replacePart(settled)
  }

  private finishOpenTools(
    status: "error" | "cancelled",
    error: string,
  ): void {
    for (const [callID, current] of this.toolParts) {
      const settled: IToolPart = {
        ...current,
        status,
        error,
        startedAt: current.startedAt ?? this.options.now(),
        completedAt: this.options.now(),
      }
      this.replacePart(settled)
      this.toolParts.delete(callID)
    }
  }

  private finish(
    reason: string,
    error?: { readonly name: string; readonly message: string },
  ): void {
    this.finished = true
    this.textParts.clear()
    this.reasoningParts.clear()
    this.toolParts.clear()
    this.message = {
      ...this.message,
      completedAt: this.options.now(),
      finish: reason,
      ...(error ? { error } : {}),
    }
  }

  private replacePart(part: TPart): void {
    const index = this.parts.findIndex((candidate) => candidate.id === part.id)
    if (index !== -1) this.parts[index] = part
  }
}

function normalizeError(
  value: unknown,
): { readonly name: string; readonly message: string } {
  if (value instanceof Error) {
    return {
      name: value.name || "Error",
      message: value.message,
    }
  }
  return { name: "Error", message: String(value) }
}
