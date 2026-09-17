import type {
    IUserImageAttachment,
    TUserInput,
    IUserInputContent,
    IUserPathReference,
    IUserSourceText,
} from "@/agent"
import { displayTextWidth } from "@/common/display-text"

export interface IPathMention {
    readonly query: string
    readonly start: number
    readonly end: number
}

export function cloneUserInput(input: IUserInputContent): IUserInputContent {
    return {
        text: input.text,
        ...(input.references?.length
            ? { references: structuredClone(input.references) }
            : {}),
        ...(input.attachments?.length
            ? { attachments: structuredClone(input.attachments) }
            : {}),
    }
}

export function sameUserInput(left: IUserInputContent, right: IUserInputContent): boolean {
    return left.text === right.text
        && sameResources(left.references ?? [], right.references ?? [])
        && sameResources(left.attachments ?? [], right.attachments ?? [])
}

export function trimUserInput(input: IUserInputContent): IUserInputContent {
    const leading = input.text.match(/^\s*/)?.[0] ?? ""
    const text = input.text.trim()
    const leadingWidth = promptOffsetWidth(leading)
    const textWidth = promptOffsetWidth(text)
    const adjustSource = (source: IUserSourceText): IUserSourceText | undefined => {
        const start = source.start - leadingWidth
        const end = source.end - leadingWidth
        if (start < 0 || end > textWidth || end <= start) return undefined
        return { ...source, start, end }
    }
    const references = (input.references ?? []).flatMap((reference) => {
        const source = adjustSource(reference.source)
        return source ? [{ ...reference, source }] : []
    })
    const attachments = (input.attachments ?? []).flatMap((attachment) => {
        const source = adjustSource(attachment.source)
        return source ? [{ ...attachment, source }] : []
    })
    return {
        text,
        ...(references.length ? { references } : {}),
        ...(attachments.length ? { attachments } : {}),
    }
}

export function mergeUserInputs(inputs: readonly TUserInput[]): IUserInputContent {
    let text = ""
    const references: IUserPathReference[] = []
    const attachments: IUserImageAttachment[] = []
    for (const value of inputs) {
        const input = typeof value === "string" ? { text: value } : value
        if (!input.text.trim() && !input.attachments?.length) continue
        const separator = text ? "\n\n" : ""
        const shift = promptOffsetWidth(text + separator)
        text += separator + input.text
        for (const reference of input.references ?? []) {
            references.push({
                ...structuredClone(reference),
                source: shiftSource(reference.source, shift),
            })
        }
        for (const attachment of input.attachments ?? []) {
            attachments.push({
                ...structuredClone(attachment),
                source: shiftSource(attachment.source, shift),
            })
        }
    }
    return {
        text,
        ...(references.length ? { references } : {}),
        ...(attachments.length ? { attachments } : {}),
    }
}

export function pathMentionFromPrefix(
    prefix: string,
    cursorOffset: number,
): IPathMention | undefined {
    const index = prefix.lastIndexOf("@")
    if (index < 0) return undefined
    const before = index === 0 ? undefined : prefix[index - 1]
    if (before !== undefined && !/\s/.test(before)) return undefined

    const token = prefix.slice(index)
    if (token.startsWith('@"')) {
        if (token.slice(2).includes('"')) return undefined
    } else if (/\s/.test(token)) {
        return undefined
    }
    return {
        query: token.slice(1),
        start: cursorOffset - promptOffsetWidth(token),
        end: cursorOffset,
    }
}

export function promptOffsetWidth(value: string): number {
    return displayTextWidth(value)
}

function shiftSource(source: IUserSourceText, shift: number): IUserSourceText {
    return {
        ...source,
        start: source.start + shift,
        end: source.end + shift,
    }
}

function sameResources(
    left: readonly (IUserPathReference | IUserImageAttachment)[],
    right: readonly (IUserPathReference | IUserImageAttachment)[],
): boolean {
    if (left.length !== right.length) return false
    return left.every((resource, index) => {
        const candidate = right[index]
        if (!candidate || resource.type !== candidate.type) return false
        if (
            resource.source.value !== candidate.source.value
            || resource.source.start !== candidate.source.start
            || resource.source.end !== candidate.source.end
        ) return false
        if (resource.type === "path" && candidate.type === "path") {
            return resource.kind === candidate.kind && resource.path === candidate.path
        }
        if (resource.type === "image" && candidate.type === "image") {
            return resource.mimeType === candidate.mimeType
                && resource.data === candidate.data
                && resource.filename === candidate.filename
        }
        return false
    })
}
