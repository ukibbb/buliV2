export const TOOL_OUTPUT_PARTS = [
    "content",
    "summary",
    "stdout",
    "stderr",
] as const

export type TToolOutputPart = typeof TOOL_OUTPUT_PARTS[number]
export type TToolOutputEncoding = "text" | "base64"

export interface IToolOutputIdentity {
    readonly sessionId: string
    readonly runId: string
    readonly toolCallId: string
    readonly toolName: string
}

export interface IStoredToolOutput {
    readonly outputId: string
}

export interface IToolOutputPage {
    readonly outputId: string
    readonly part: TToolOutputPart
    readonly encoding: TToolOutputEncoding
    readonly offset: number
    readonly content: string
    readonly contentBytes: number
    readonly totalBytes: number
    readonly nextOffset?: number
}

export interface IToolOutputWriter {
    readonly write: (
        part: TToolOutputPart,
        chunk: Uint8Array,
    ) => Promise<void>
    readonly commit: () => Promise<IStoredToolOutput>
    readonly discard: () => Promise<void>
}

/** Active-application backing storage for complete tool results. */
export interface IToolOutputStore {
    readonly store: (
        identity: IToolOutputIdentity,
        parts: Readonly<Partial<Record<TToolOutputPart, string | Uint8Array>>>,
    ) => Promise<IStoredToolOutput>
    readonly createWriter: (
        identity: IToolOutputIdentity,
    ) => Promise<IToolOutputWriter>
    readonly readPage: (options: {
        readonly sessionId: string
        readonly outputId: string
        readonly part: TToolOutputPart
        readonly encoding: TToolOutputEncoding
        readonly offset: number
        readonly maxBytes: number
        readonly maxLines: number
    }) => Promise<IToolOutputPage>
    readonly dispose: () => Promise<void>
}
