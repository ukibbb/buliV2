/** What Buli knows about the visible session when a status line is drawn. */
export interface IStatusLineSession {
    readonly sessionId: string | undefined
    readonly modelId: string
    readonly modelName: string
    readonly inputTokens: number
    readonly contextWindowTokens: number | undefined
}

/** Draws the status line for a session; undefined when there is nothing to show. */
export type TRenderStatusLine = (session: IStatusLineSession, signal: AbortSignal) => Promise<string | undefined>
