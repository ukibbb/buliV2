import type {
  IAssistantMessage,
  IReasoningContent,
  ITextContent,
  IToolCallContent,
  TAssistantContent,
} from "@/agent/messages"
import type { IAgentModelEvent } from "@/agent/model"
import type { IModelProfile, IModelUsage } from "@/agent/model-values"

interface IAssistantMessageBuilderOptions {
  readonly sessionId: string
  readonly runId: string
  readonly now: () => number
  readonly generateId: () => string
  readonly modelProfile?: IModelProfile
}

const immutableAssistantSnapshots = new WeakSet<IAssistantMessage>()

/** Identifies builder snapshots that are safe to retain without another clone. */
export function isImmutableAssistantSnapshot(
  message: IAssistantMessage,
): boolean {
  return immutableAssistantSnapshots.has(message)
}

/** Reduces one provider stream into one assistant message. */
export class AssistantMessageBuilder {
  private readonly messageId: string
  private readonly createdAt: number
  private readonly content: TAssistantContent[] = []
  private readonly textContent = new Map<string, ITextContent>()
  private readonly reasoningContent = new Map<string, IReasoningContent>()
  private stopReason = "pending"
  private errorMessage: string | undefined
  private usage: IModelUsage | undefined

  constructor(private readonly options: IAssistantMessageBuilderOptions) {
    this.messageId = options.generateId()
    this.createdAt = options.now()
  }

  get completed(): boolean {
    return this.stopReason !== "pending"
  }

  apply(event: IAgentModelEvent): void {
    if (this.completed) return

    switch (event.type) {
      case "text-start":
        this.startText(event.id)
        return
      case "text-delta":
        this.appendText(event.id, event.delta)
        return
      case "text-end":
        this.textContent.delete(event.id)
        return
      case "reasoning-start":
        this.startReasoning(event.id)
        return
      case "reasoning-delta":
        this.appendReasoning(event.id, event.delta)
        return
      case "reasoning-end":
        this.reasoningContent.delete(event.id)
        return
      case "tool-call":
        this.addToolCall(event)
        return
      case "finish":
        this.finish(event.reason, undefined, event.usage)
        return
      case "abort":
        this.abort(event.reason ?? "Buli interaction was aborted")
        return
      case "error":
        this.finish("error", errorMessage(event.error))
    }
  }

  finish(reason = "stop", error?: string, usage?: IModelUsage): void {
    if (this.completed) return
    this.stopReason = reason
    this.errorMessage = error
    this.usage = usage === undefined ? undefined : structuredClone(usage)
    this.textContent.clear()
    this.reasoningContent.clear()
  }

  abort(reason: string): void {
    this.stopReason = "aborted"
    this.errorMessage = reason
    this.textContent.clear()
    this.reasoningContent.clear()
  }

  snapshot(): IAssistantMessage {
    const snapshot: IAssistantMessage = structuredClone({
      id: this.messageId,
      sessionId: this.options.sessionId,
      runId: this.options.runId,
      role: "assistant" as const,
      content: this.content,
      stopReason: this.stopReason,
      ...(this.errorMessage ? { errorMessage: this.errorMessage } : {}),
      ...(this.options.modelProfile
        ? { model: this.options.modelProfile }
        : {}),
      ...(this.usage ? { usage: this.usage } : {}),
      createdAt: this.createdAt,
    })
    // Every published generation is detached from mutable builder storage.
    deepFreeze(snapshot)
    immutableAssistantSnapshots.add(snapshot)
    return snapshot
  }

  private startText(id: string): void {
    if (this.textContent.has(id)) return
    const content: ITextContent = { type: "text", text: "" }
    this.textContent.set(id, content)
    this.content.push(content)
  }

  private appendText(id: string, delta: string): void {
    const current = this.textContent.get(id)
    if (!current) return
    const updated: ITextContent = { ...current, text: current.text + delta }
    this.textContent.set(id, updated)
    this.replaceContent(current, updated)
  }

  private startReasoning(id: string): void {
    if (this.reasoningContent.has(id)) return
    const content: IReasoningContent = { type: "reasoning", text: "" }
    this.reasoningContent.set(id, content)
    this.content.push(content)
  }

  private appendReasoning(id: string, delta: string): void {
    const current = this.reasoningContent.get(id)
    if (!current) return
    const updated: IReasoningContent = { ...current, text: current.text + delta }
    this.reasoningContent.set(id, updated)
    this.replaceContent(current, updated)
  }

  private addToolCall(
    event: Extract<IAgentModelEvent, { type: "tool-call" }>,
  ): void {
    if (
      this.content.some(
        (content) => content.type === "toolCall"
          && content.toolCallId === event.toolCallId,
      )
    ) {
      return
    }

    const content: IToolCallContent = {
      type: "toolCall",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: structuredClone(event.input),
    }
    this.content.push(content)
  }

  private replaceContent(
    current: TAssistantContent,
    replacement: TAssistantContent,
  ): void {
    const index = this.content.indexOf(current)
    if (index !== -1) this.content[index] = replacement
  }
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object") return
  for (const child of Object.values(value)) deepFreeze(child)
  Object.freeze(value)
}
