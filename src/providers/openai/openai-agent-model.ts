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
import type { TAgentMessage } from "@/domain"
import { OpenAiAuth } from "@/providers/openai/openai-auth"
import { OPENAI_OAUTH_DUMMY_API_KEY } from "@/providers/openai/openai-constants"

export const DEFAULT_OPENAI_MODEL_ID = "gpt-5.6-sol"

export interface IOpenAiAgentModelOptions {
  readonly auth?: OpenAiAuth
  readonly modelId?: string
}

type AIStreamEvent = ReturnType<typeof streamText<ToolSet>>["stream"] extends
  AsyncIterable<infer Event> ? Event : never
type AIAssistantPart = Exclude<AssistantContent, string>[number]

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
      messages: toModelMessages(request.messages),
      tools: toAiTools(request.tools),
      abortSignal: request.signal,
      providerOptions: {
        openai: {
          store: false,
          instructions: request.systemPrompt,
          // TODO: Verify with a live gpt-5.6-sol request that one response can
          // contain multiple local calls. Buli intentionally executes that
          // returned batch sequentially; benchmark before adding concurrency.
          parallelToolCalls: true,
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
      inputSchema: jsonSchema<Record<string, unknown>>(
        descriptor.inputSchema as JSONSchema7,
      ),
      outputSchema: jsonSchema<string>({ type: "string" }),
    }),
  ])) as ToolSet
}

function toModelMessages(messages: readonly TAgentMessage[]): ModelMessage[] {
  return messages.flatMap((message): ModelMessage[] => {
    switch (message.role) {
      case "user":
        return [{ role: "user", content: message.content }]
      case "assistant": {
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          return []
        }

        const content: Exclude<AssistantContent, string> = message.content.flatMap(
          (item): AIAssistantPart[] => {
            switch (item.type) {
              case "text":
                return [{ type: "text", text: item.text }]
              case "reasoning":
                return []
              case "toolCall":
                return [{
                  type: "tool-call" as const,
                  toolCallId: item.toolCallId,
                  toolName: item.toolName,
                  input: structuredClone(item.input),
                }]
            }
          },
        )
        return content.length > 0 ? [{ role: "assistant", content }] : []
      }
      case "toolResult": {
        const content: ToolContent = [{
          type: "tool-result",
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          output: message.isError
            ? { type: "error-text", value: message.content }
            : { type: "text", value: message.content },
        }]
        return [{ role: "tool", content }]
      }
    }
  })
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
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: toRecord(event.input),
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

function toRecord(value: unknown): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError("Tool input must be an object")
  }
  return structuredClone(value as Record<string, unknown>)
}
