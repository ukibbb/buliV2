import { abortMessage } from "@/agent/abort"
import { AssistantMessageBuilder } from "@/agent/model/assistant-message-builder"
import type { TAgentEvent } from "@/agent/runtime/events"
import type {
    TAgentMessage,
    IAssistantMessage,
} from "@/agent/messages/messages"
import type { IAgentModel } from "@/agent/model/model"
import type {
    IModelProfile,
    TReasoningEffort,
} from "@/agent/model/model-values"
import type { IAgentToolDescriptor } from "@/agent/tools/tool"

interface IStreamModelTurnOptions {
    readonly sessionId: string
    readonly runId: string
    readonly systemPrompt: string
    readonly contextSummary?: string
    readonly messages: readonly TAgentMessage[]
    readonly model: IAgentModel
    readonly modelProfile?: IModelProfile
    readonly reportProviderAccountId?: (accountId: string) => void
    readonly tools: readonly IAgentToolDescriptor[]
    readonly reasoningEffort: TReasoningEffort
    readonly signal: AbortSignal
    readonly emit: (event: TAgentEvent) => void | Promise<void>
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
            messages: options.messages,
            tools,
            reasoningEffort: options.reasoningEffort,
            signal: options.signal,
            ...(options.reportProviderAccountId === undefined
                ? {}
                : {
                    reportProviderAccountId:
                        options.reportProviderAccountId,
                }),
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
            builder.abort(abortMessage(options.signal))
        } else {
            builder.finish("error", errorMessage(error))
        }
    }

    if (options.signal.aborted) {
        builder.abort(abortMessage(options.signal))
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

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
