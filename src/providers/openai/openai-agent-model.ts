import { createOpenAI } from "@ai-sdk/openai"
import {
  isStepCount,
  jsonSchema,
  streamText,
  tool,
  type AssistantContent,
  type JSONSchema7,
  type ModelMessage,
  type ToolContent,
  type ToolSet,
} from "ai"

import type {
  IAgentModel,
  IAgentModelEvent,
  IAgentModelRequest,
  IAgentToolDescriptor,
} from "@/agent/agent-types"
import type {
  IBuliMessageWithParts,
  IToolPart,
  TJsonObject,
  TJsonValue,
} from "@/domain"
import { OpenAiAuth } from "@/providers/openai/openai-auth"
import { OPENAI_OAUTH_DUMMY_API_KEY } from "@/providers/openai/openai-constants"

export const DEFAULT_OPENAI_MODEL_ID = "gpt-5.6-sol"

export interface IOpenAiAgentModelOptions {
  readonly auth?: OpenAiAuth
  readonly modelId?: string
}

type AIStreamEvent = ReturnType<typeof streamText<ToolSet>>["stream"] extends
  AsyncIterable<infer Event> ? Event : never
type AIAssistantParts = Exclude<AssistantContent, string>
type AIToolResult = Extract<ToolContent[number], { type: "tool-result" }>
type AIToolResultOutput = AIToolResult["output"]

/** Translates one Buli model turn to and from the OpenAI AI SDK protocol. */
export class OpenAiAgentModel implements IAgentModel {
  private readonly auth: OpenAiAuth
  private readonly modelId: string

  constructor(options: IOpenAiAgentModelOptions = {}) {
    this.auth = options.auth ?? new OpenAiAuth()
    this.modelId = options.modelId ?? DEFAULT_OPENAI_MODEL_ID
  }

  async *stream(
    request: IAgentModelRequest,
  ): AsyncIterable<IAgentModelEvent> {
    request.signal.throwIfAborted()
    await this.auth.requireCredential(request.signal)
    request.signal.throwIfAborted()

    const provider = createOpenAI({
      apiKey: OPENAI_OAUTH_DUMMY_API_KEY,
      fetch: this.auth.authenticatedFetch,
    })
    const result = streamText({
      model: provider.responses(this.modelId),
      messages: historyToModelMessages(request.history),
      tools: toAiTools(request.tools),
      abortSignal: request.signal,
      providerOptions: {
        openai: {
          store: false,
          instructions: request.systemPrompt,
        },
      },
      stopWhen: isStepCount(1),
      maxRetries: 0,
    })

    for await (const event of result.stream) {
      const modelEvent = toAgentModelEvent(event)
      if (modelEvent) yield modelEvent
    }
  }
}

function toAiTools(
  descriptors: readonly IAgentToolDescriptor[],
): ToolSet {
  return Object.fromEntries(descriptors.map((descriptor) => [
    descriptor.name,
    tool({
      description: descriptor.description,
      inputSchema: jsonSchema<TJsonObject>(
        descriptor.inputSchema as JSONSchema7,
      ),
      outputSchema: jsonSchema<TJsonValue>({} as JSONSchema7),
    }),
  ])) as ToolSet
}

function historyToModelMessages(
  history: readonly IBuliMessageWithParts[],
): ModelMessage[] {
  const messages: ModelMessage[] = []

  for (const message of history) {
    if (message.info.role === "user") {
      const content = message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n\n")
        .trim()

      if (content) messages.push({ role: "user", content })
      continue
    }

    const assistant: AIAssistantParts = []
    const tools: ToolContent = []

    for (const part of message.parts) {
      if (part.type === "text") {
        if (part.text) assistant.push({ type: "text", text: part.text })
        continue
      }
      if (part.type !== "tool") continue

      assistant.push({
        type: "tool-call",
        toolCallId: part.callID,
        toolName: part.tool,
        input: structuredClone(part.input),
        ...(part.execution === "provider" ? { providerExecuted: true } : {}),
      })

      const result: AIToolResult = {
        type: "tool-result",
        toolCallId: part.callID,
        toolName: part.tool,
        output: toolResultOutput(part),
      }
      if (part.execution === "provider") assistant.push(result)
      else tools.push(result)
    }

    if (assistant.length > 0) messages.push({ role: "assistant", content: assistant })
    if (tools.length > 0) messages.push({ role: "tool", content: tools })
  }

  return messages
}

function toolResultOutput(part: IToolPart): AIToolResultOutput {
  if (part.status === "completed") {
    const output = structuredClone(part.output ?? null)
    return typeof output === "string"
      ? { type: "text", value: output }
      : { type: "json", value: output }
  }

  const fallback = part.status === "cancelled"
    ? "Tool execution was cancelled."
    : part.status === "error"
      ? "Tool execution failed."
      : "Tool execution was interrupted before completion."

  return { type: "error-text", value: part.error ?? fallback }
}

function toAgentModelEvent(
  event: AIStreamEvent,
): IAgentModelEvent | undefined {
  switch (event.type) {
    case "text-start":
      return { type: "text-start", id: event.id }
    case "text-delta":
      return { type: "text-delta", id: event.id, delta: event.text }
    case "text-end":
      return { type: "text-end", id: event.id }
    case "reasoning-start":
      return { type: "reasoning-start", id: event.id }
    case "reasoning-delta":
      return { type: "reasoning-delta", id: event.id, delta: event.text }
    case "reasoning-end":
      return { type: "reasoning-end", id: event.id }
    case "tool-call":
      return {
        type: "tool-call",
        callID: event.toolCallId,
        tool: event.toolName,
        input: toJsonObject(event.input),
        execution: event.providerExecuted === true ? "provider" : "local",
      }
    case "tool-result":
      return {
        type: "tool-result",
        callID: event.toolCallId,
        tool: event.toolName,
        input: toJsonObject(event.input),
        output: toJsonValue(event.output),
        execution: event.providerExecuted === true ? "provider" : "local",
      }
    case "tool-error":
      return {
        type: "tool-error",
        callID: event.toolCallId,
        tool: event.toolName,
        input: toJsonObject(event.input),
        error: errorMessage(event.error),
        execution: event.providerExecuted === true ? "provider" : "local",
      }
    case "finish":
      return {
        type: "finish",
        reason: event.rawFinishReason ?? event.finishReason,
      }
    case "abort":
      return {
        type: "abort",
        ...(event.reason ? { reason: event.reason } : {}),
      }
    case "error":
      return { type: "error", error: event.error }
    default:
      return undefined
  }
}

function toJsonValue(value: unknown): TJsonValue {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) return null
  return JSON.parse(serialized) as TJsonValue
}

function toJsonObject(value: unknown): TJsonObject {
  const normalized = toJsonValue(value)
  if (
    normalized === null
    || Array.isArray(normalized)
    || typeof normalized !== "object"
  ) {
    throw new TypeError("Tool input must be a JSON object")
  }
  return normalized
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
