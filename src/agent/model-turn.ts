import { AssistantMessageBuilder } from "@/agent/assistant-message-builder"
import type { IAgentEvent } from "@/agent/events"
import type {
    IAssistantMessage,
    TAgentMessage,
} from "@/agent/messages"
import type { IAgentModel } from "@/agent/model"
import type {
    IModelProfile,
    TReasoningEffort,
} from "@/agent/model-values"
import type { IAgentToolDescriptor } from "@/agent/tool"

interface IStreamModelTurnOptions {
    readonly sessionId: string
    readonly runId: string
    readonly systemPrompt: string
    readonly contextSummary?: string
    readonly messages: readonly TAgentMessage[]
    readonly model: IAgentModel
    readonly modelProfile?: IModelProfile
    readonly tools: readonly IAgentToolDescriptor[]
    readonly reasoningEffort: TReasoningEffort
    readonly signal: AbortSignal
    readonly emit: (event: IAgentEvent) => void | Promise<void>
    readonly now: () => number
    readonly generateId: () => string
}

/** Streams one provider turn and publishes its normalized assistant lifecycle. */
export async function streamModelTurn(
    options: IStreamModelTurnOptions,
): Promise<IAssistantMessage> {
    const builder = new AssistantMessageBuilder({
        sessionId: options.sessionId,
        runId: options.runId,
        now: options.now,
        generateId: options.generateId,
        ...(options.modelProfile === undefined
            ? {}
            : { modelProfile: options.modelProfile }),
    })
    await options.emit({
        type: "message_start",
        runId: options.runId,
        message: builder.snapshot(),
    })

    try {
        const tools = options.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: structuredClone(tool.inputSchema),
        }))
        const stream = options.model.stream({
            sessionId: options.sessionId,
            runId: options.runId,
            systemPrompt: options.systemPrompt,
            ...(options.contextSummary === undefined
                ? {}
                : { contextSummary: options.contextSummary }),
            messages: structuredClone(options.messages),
            tools,
            reasoningEffort: options.reasoningEffort,
            signal: options.signal,
        })

        for await (const modelEvent of stream) {
            builder.apply(modelEvent)
            if (
                modelEvent.type !== "finish"
                && modelEvent.type !== "abort"
                && modelEvent.type !== "error"
            ) {
                await options.emit({
                    type: "message_update",
                    runId: options.runId,
                    message: builder.snapshot(),
                    modelEvent,
                })
            }
            if (builder.completed) break
        }
    } catch (error) {
        if (options.signal.aborted) {
            builder.abort(abortReason(options.signal))
        } else {
            builder.finish("error", errorMessage(error))
        }
    }

    if (options.signal.aborted) {
        builder.abort(abortReason(options.signal))
    } else if (!builder.completed) {
        builder.finish("error", "Model stream ended without a terminal event")
    }

    const assistant = builder.snapshot()
    await options.emit({
        type: "message_end",
        runId: options.runId,
        message: assistant,
    })
    return assistant
}

function abortReason(signal: AbortSignal): string {
    if (signal.reason instanceof Error) return signal.reason.message
    return typeof signal.reason === "string"
        ? signal.reason
        : "Buli interaction was aborted"
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
