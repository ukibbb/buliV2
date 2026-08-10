import { realpath } from "node:fs/promises"

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
  IBuliMessageWithParts,
  IToolPart,
  TJsonObject,
  TJsonValue,
} from "@/domain"
import type {
  IBuliUserInteractionRequest,
  IInteractionEvent,
  IUserBuliInteractionDriver,
} from "@/engine/interaction-driver"
import { systemPrompt } from "@/agents/agents-prompts"
import { OpenAiAuth } from "@/providers/openai/openai-auth"
import { OPENAI_OAUTH_DUMMY_API_KEY } from "@/providers/openai/openai-constants"
import type {
  BuliToolRegistry,
  IToolExecutionContext,
} from "@/tools/tool-registry"
import { createWorkspaceToolRegistry } from "@/tools/workspace-tools"

export const DEFAULT_OPENAI_MODEL_ID = "gpt-5.6-sol"

export interface OpenAiUserBuliInteractionDriverOptions {
  readonly auth?: OpenAiAuth
  readonly modelId?: string
  readonly toolRegistry?: BuliToolRegistry
}

type AIStreamEvent = ReturnType<typeof streamText<ToolSet>>["stream"] extends
  AsyncIterable<infer Event> ? Event : never

/** Sends history to OpenAI and converts one provider step into Buli events. */
export class OpenAiUserBuliInteractionDriver implements IUserBuliInteractionDriver {
  private readonly auth: OpenAiAuth
  private readonly modelId: string
  private readonly toolRegistry: BuliToolRegistry

  constructor(options: OpenAiUserBuliInteractionDriverOptions = {}) {
    this.auth = options.auth ?? new OpenAiAuth()
    this.modelId = options.modelId ?? DEFAULT_OPENAI_MODEL_ID
    this.toolRegistry = options.toolRegistry ?? createWorkspaceToolRegistry()
  }

  async *interaction(
    request: IBuliUserInteractionRequest,
  ): AsyncIterable<IInteractionEvent> {
    const messages = historyToModelMessages(request.history)

    request.signal.throwIfAborted()
    await this.auth.requireCredential(request.signal)
    const workspaceRoot = await realpath(process.cwd())
    request.signal.throwIfAborted()
    const provider = createOpenAI({
      apiKey: OPENAI_OAUTH_DUMMY_API_KEY,
      fetch: this.auth.authenticatedFetch,
    })
    const result = streamText({
      model: provider.responses(this.modelId),
      messages,
      tools: toAiTools(this.toolRegistry, {
        workspaceRoot,
        signal: request.signal,
      }),
      abortSignal: request.signal,
      providerOptions: {
        openai: {
          store: false,
          instructions: systemPrompt(),
        },
      },
      stopWhen: isStepCount(1),
      maxRetries: 0,
    })

    for await (const event of result.stream) {
      const interactionEvent = toInteractionEvent(event)
      if (interactionEvent) yield interactionEvent
    }
  }
}

function toAiTools(
  registry: BuliToolRegistry,
  context: IToolExecutionContext,
): ToolSet {
  return Object.fromEntries(
    registry.definitions().map((definition) => [
      definition.name,
      tool({
        description: definition.description,
        inputSchema: jsonSchema<TJsonObject>(
          definition.inputSchema as JSONSchema7,
        ),
        execute: (input) => registry.execute(definition.name, input, context),
      }),
    ]),
  ) as ToolSet
}

type AIAssistantParts = Exclude<AssistantContent, string>
type AIToolResult = Extract<ToolContent[number], { type: "tool-result" }>
type AIToolResultOutput = AIToolResult["output"]

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

      if (part.execution === "provider") {
        assistant.push(result)
      } else {
        tools.push(result)
      }
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

  return {
    type: "error-text",
    value: part.error ?? fallback,
  }
}

function toInteractionEvent(event: AIStreamEvent): IInteractionEvent | undefined {
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
