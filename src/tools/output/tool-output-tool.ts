import { Type } from "typebox"

import {
    TOOL_OUTPUT_PARTS,
    type IAgentTool,
    type IToolOutputStore,
    type TToolOutputEncoding,
    type TToolOutputPart,
} from "@/agent"

export const DEFAULT_TOOL_OUTPUT_PAGE_BYTES = 48 * 1024
export const MAX_TOOL_OUTPUT_PAGE_BYTES = 64 * 1024
export const DEFAULT_TOOL_OUTPUT_PAGE_LINES = 1_000
export const MAX_TOOL_OUTPUT_PAGE_LINES = 1_500
const INPUT_KEYS = new Set([
    "outputId",
    "part",
    "encoding",
    "offset",
    "maxBytes",
    "maxLines",
])

const TOOL_OUTPUT_INPUT_SCHEMA = Type.Object({
    outputId: Type.String({
        minLength: 1,
        maxLength: 128,
        description: "Opaque output ID returned by an earlier tool call",
    }),
    part: Type.Optional(Type.Union(
        TOOL_OUTPUT_PARTS.map((part) => Type.Literal(part)),
        { default: "content" },
    )),
    encoding: Type.Optional(Type.Union([
        Type.Literal("text"),
        Type.Literal("base64"),
    ], {
        default: "text",
        description: "Use base64 when a part contains non-UTF-8 bytes",
    })),
    offset: Type.Optional(Type.Integer({
        minimum: 0,
        default: 0,
        description: "UTF-8 byte offset returned by the previous page",
    })),
    maxBytes: Type.Optional(Type.Integer({
        minimum: 4,
        maximum: MAX_TOOL_OUTPUT_PAGE_BYTES,
        default: DEFAULT_TOOL_OUTPUT_PAGE_BYTES,
    })),
    maxLines: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: MAX_TOOL_OUTPUT_PAGE_LINES,
        default: DEFAULT_TOOL_OUTPUT_PAGE_LINES,
    })),
}, { additionalProperties: false })

/** Creates the read-only pager for complete outputs retained during this app lifetime. */
export function createToolOutputTool(
    store: IToolOutputStore,
): IAgentTool<typeof TOOL_OUTPUT_INPUT_SCHEMA> {
    return {
        name: "tool_output",
        description: "Read an exact page from a large tool result retained for the active Buli application. Continue with the returned byte offset; use base64 for non-UTF-8 output. Output IDs expire when the application closes.",
        inputSchema: TOOL_OUTPUT_INPUT_SCHEMA,
        execute: async (input, context) => {
            context.signal.throwIfAborted()
            assertOnlyInputKeys(input)
            const outputId = requireNonEmptyString(input.outputId, "outputId")
            const part = optionalPart(input.part)
            const encoding = optionalEncoding(input.encoding)
            const offset = optionalInteger(input.offset, "offset", 0, 0)
            const maxBytes = optionalInteger(
                input.maxBytes,
                "maxBytes",
                DEFAULT_TOOL_OUTPUT_PAGE_BYTES,
                4,
                MAX_TOOL_OUTPUT_PAGE_BYTES,
            )
            const maxLines = optionalInteger(
                input.maxLines,
                "maxLines",
                DEFAULT_TOOL_OUTPUT_PAGE_LINES,
                1,
                MAX_TOOL_OUTPUT_PAGE_LINES,
            )
            const page = await store.readPage({
                sessionId: context.sessionId,
                outputId,
                part,
                encoding,
                offset,
                maxBytes,
                maxLines,
            })
            context.signal.throwIfAborted()

            const end = page.offset + page.contentBytes
            const lines = [
                `outputId: ${page.outputId}`,
                `part: ${page.part}`,
                `encoding: ${page.encoding}`,
                `bytes: ${page.offset}-${end} of ${page.totalBytes}`,
                "data:",
                page.content,
            ]
            if (page.nextOffset !== undefined) {
                lines.push(
                    `[Tool output page complete; continue with outputId=${JSON.stringify(page.outputId)}, part=${JSON.stringify(page.part)}, encoding=${JSON.stringify(page.encoding)}, offset=${page.nextOffset}]`,
                )
            } else {
                lines.push("[Tool output complete]")
            }
            return lines.join("\n")
        },
    }
}

function assertOnlyInputKeys(input: Record<string, unknown>): void {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new TypeError("Tool input must be an object")
    }
    for (const key of Object.keys(input)) {
        if (!INPUT_KEYS.has(key)) {
            throw new TypeError(`Tool input contains unknown property ${JSON.stringify(key)}`)
        }
    }
}

function optionalPart(value: unknown): TToolOutputPart {
    if (value === undefined) return "content"
    if (typeof value === "string" && TOOL_OUTPUT_PARTS.includes(value as TToolOutputPart)) {
        return value as TToolOutputPart
    }
    throw new TypeError("part must be content, summary, stdout, or stderr")
}

function optionalEncoding(value: unknown): TToolOutputEncoding {
    if (value === undefined) return "text"
    if (value === "text" || value === "base64") return value
    throw new TypeError("encoding must be text or base64")
}

function optionalInteger(
    value: unknown,
    name: string,
    fallback: number,
    minimum: number,
    maximum = Number.MAX_SAFE_INTEGER,
): number {
    if (value === undefined) return fallback
    if (
        !Number.isSafeInteger(value)
        || Number(value) < minimum
        || Number(value) > maximum
    ) {
        throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`)
    }
    return Number(value)
}

function requireNonEmptyString(value: unknown, name: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new TypeError(`${name} must be a nonempty string`)
    }
    return value
}
