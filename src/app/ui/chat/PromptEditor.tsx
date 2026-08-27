import {
    type ClipboardService,
    type PasteEvent,
    TextareaRenderable,
    type KeyBinding,
    type KeyEvent,
} from "@opentui/core"
import { useEffect, useRef } from "react"

import {
    isSupportedImageMime,
    prepareClipboardImage,
} from "@/app/ui/chat/prompt-attachments"
import {
    cloneUserInput,
    pathMentionFromPrefix,
    sameUserInput,
    type IPathMention,
} from "@/app/ui/chat/prompt-draft"
import { buliKeyboardShortcuts } from "@/app/ui/keyboard-shortcuts"
import type {
    IPathCompletion,
} from "@/app/ui/controller/path-menu"
import type {
    TBuliInputDelivery,
    TBuliInputSubmitResult,
} from "@/app/ui/ui-controller"
import type {
    UserImageAttachment,
    UserInputContent,
    UserPathReference,
} from "@/agent"
import {
    USER_IMAGE_ATTACHMENTS_MAX,
    USER_IMAGE_TOTAL_MAX_BYTES,
} from "@/agent"

const CHAT_MIN_ROW_COUNT = 3
const CHAT_MAX_ROW_COUNT = 6

const chatTextAreaKeybindings: KeyBinding[] = [
    { name: "return", action: "submit" },
]

interface IPromptEditorProps {
    readonly value: UserInputContent
    readonly blocked: boolean
    readonly menuOpen: boolean
    readonly clipboard?: Pick<ClipboardService, "read">
    readonly getCurrentValue: () => UserInputContent
    readonly onValueChange: (
        value: UserInputContent,
        mention?: IPathMention,
    ) => void
    readonly onSubmit: (
        input: UserInputContent,
        delivery: TBuliInputDelivery,
    ) => Promise<TBuliInputSubmitResult>
    readonly onMoveMenuSelection: (direction: -1 | 1) => void
    readonly onActivateMenuItem: () => Promise<IPathCompletion | void>
    readonly onError: (error: unknown) => void
}

interface ITrackedPathReference {
    readonly markId: number
    readonly token: number
    readonly value: string
    readonly reference: Omit<UserPathReference, "source">
}

interface ITrackedImageAttachment {
    readonly markId: number
    readonly token: number
    readonly value: string
    readonly attachment: Omit<UserImageAttachment, "source">
}

/** Owns the controlled terminal textarea, focus, keys, and safe draft clearing. */
export function PromptEditor(props: IPromptEditorProps) {
    const textAreaRef = useRef<TextareaRenderable | null>(null)
    const referencesRef = useRef<ITrackedPathReference[]>([])
    const attachmentsRef = useRef<ITrackedImageAttachment[]>([])
    const synchronizingRef = useRef(false)
    const clipboardGenerationRef = useRef(0)
    const activeClipboardReadRef = useRef<AbortController | undefined>(undefined)
    const nextImageNumberRef = useRef(1)
    const nextExtmarkTokenRef = useRef(1)

    useEffect(() => {
        const textArea = textAreaRef.current
        if (!textArea) return
        const current = buildDraft(
            textArea,
            referencesRef.current,
            attachmentsRef.current,
        )
        if (sameUserInput(current, props.value)) return

        cancelClipboardRead("Prompt draft was replaced")
        synchronizingRef.current = true
        try {
            textArea.setText(props.value.text)
            referencesRef.current = restorePathReferences(
                textArea,
                props.value,
                nextExtmarkTokenRef,
            )
            attachmentsRef.current = restoreImageAttachments(
                textArea,
                props.value,
                nextExtmarkTokenRef,
            )
            nextImageNumberRef.current = nextImageNumber(props.value)
        } finally {
            synchronizingRef.current = false
        }
    }, [props.value])

    useEffect(() => () => cancelClipboardRead("Prompt editor unmounted"), [])

    useEffect(() => {
        if (props.blocked) cancelClipboardRead("Prompt editor is blocked")
    }, [props.blocked])

    const cancelClipboardRead = (reason: string): void => {
        clipboardGenerationRef.current += 1
        activeClipboardReadRef.current?.abort(reason)
        activeClipboardReadRef.current = undefined
    }

    const currentDraft = (): UserInputContent => {
        const textArea = textAreaRef.current
        return textArea
            ? buildDraft(textArea, referencesRef.current, attachmentsRef.current)
            : cloneUserInput(props.value)
    }

    const publishDraft = (): void => {
        if (synchronizingRef.current) return
        const textArea = textAreaRef.current
        if (!textArea) return
        const draft = buildDraft(
            textArea,
            referencesRef.current,
            attachmentsRef.current,
        )
        const prefix = textArea.editBuffer.getTextRange(0, textArea.cursorOffset)
        props.onValueChange(
            draft,
            pathMentionFromPrefix(prefix, textArea.cursorOffset),
        )
    }

    const clearSubmittedDraft = (submittedDraft: UserInputContent): void => {
        const textArea = textAreaRef.current
        if (!textArea || !sameUserInput(currentDraft(), submittedDraft)) return
        cancelClipboardRead("Prompt draft was cleared")
        synchronizingRef.current = true
        try {
            referencesRef.current = []
            attachmentsRef.current = []
            nextImageNumberRef.current = 1
            textArea.clear()
        } finally {
            synchronizingRef.current = false
        }
        props.onValueChange({ text: "" })
    }

    const submitInput = (delivery: TBuliInputDelivery): void => {
        if (props.blocked) return
        cancelClipboardRead("Prompt was submitted")
        const input = currentDraft()
        if (!input.text.trim() && !input.attachments?.length) return

        void props.onSubmit(input, delivery).then((result) => {
            if (result === "consumed") clearSubmittedDraft(input)
        }).catch((error: unknown) => {
            console.error("Failed to handle input", error)
        })
    }

    const activateSelectedMenuItem = (): void => {
        void props.onActivateMenuItem().then((completion) => {
            if (completion) insertPathCompletion(completion)
        }).catch((error: unknown) => {
            console.error("Failed to activate menu item", error)
        })
    }

    const insertPathCompletion = (completion: IPathCompletion): void => {
        const textArea = textAreaRef.current
        if (!textArea) return
        synchronizingRef.current = true
        try {
            void textArea.extmarks
            textArea.setSelection(completion.triggerStart, completion.triggerEnd)
            textArea.insertText(completion.value)
            const end = textArea.cursorOffset
            const token = nextExtmarkTokenRef.current
            nextExtmarkTokenRef.current += 1
            const markId = textArea.extmarks.create({
                start: completion.triggerStart,
                end,
                virtual: true,
                data: token,
            })
            referencesRef.current.push({
                markId,
                token,
                value: completion.value,
                reference: completion.reference,
            })
            textArea.insertText(" ")
        } finally {
            synchronizingRef.current = false
        }
        publishDraft()
    }

    const insertImage = (mimeType: string, bytes: Uint8Array): void => {
        const textArea = textAreaRef.current
        if (!textArea) return
        const liveAttachments = attachmentsRef.current.filter(
            (record) => textArea.extmarks.get(record.markId)?.data === record.token,
        )
        if (liveAttachments.length >= USER_IMAGE_ATTACHMENTS_MAX) {
            throw new Error(
                `A prompt can contain at most ${USER_IMAGE_ATTACHMENTS_MAX} images`,
            )
        }
        const prepared = prepareClipboardImage(
            mimeType,
            bytes,
            nextImageNumberRef.current,
        )
        const totalBytes = liveAttachments.reduce(
            (total, record) => total + decodedBase64Bytes(record.attachment.data),
            bytes.byteLength,
        )
        if (totalBytes > USER_IMAGE_TOTAL_MAX_BYTES) {
            throw new Error("Prompt images exceed the 10 MiB total limit")
        }
        synchronizingRef.current = true
        try {
            void textArea.extmarks
            const start = textArea.cursorOffset
            textArea.insertText(prepared.value)
            const end = textArea.cursorOffset
            const token = nextExtmarkTokenRef.current
            nextExtmarkTokenRef.current += 1
            const markId = textArea.extmarks.create({
                start,
                end,
                virtual: true,
                data: token,
            })
            attachmentsRef.current.push({
                markId,
                token,
                value: prepared.value,
                attachment: prepared.attachment,
            })
            nextImageNumberRef.current += 1
            textArea.insertText(" ")
        } finally {
            synchronizingRef.current = false
        }
        publishDraft()
    }

    const pasteClipboard = (): void => {
        if (!props.clipboard) return
        const generation = clipboardGenerationRef.current + 1
        clipboardGenerationRef.current = generation
        activeClipboardReadRef.current?.abort("A newer clipboard read started")
        const controller = new AbortController()
        activeClipboardReadRef.current = controller
        void props.clipboard.read({
            preferredTypes: [
                "image/png",
                "image/jpeg",
                "image/webp",
                "image/gif",
                "text/plain",
            ],
            signal: controller.signal,
        }).then((result) => {
            if (
                controller.signal.aborted
                || generation !== clipboardGenerationRef.current
            ) return
            if (result.status === "failed") throw result.error
            if (result.status === "limit-exceeded") {
                throw new Error("Clipboard content exceeds the size limit")
            }
            if (result.status !== "read") return
            const { mimeType, bytes } = result.representation
            if (isSupportedImageMime(mimeType)) {
                insertImage(mimeType, bytes)
                return
            }
            if (mimeType === "text/plain") {
                textAreaRef.current?.insertText(new TextDecoder().decode(bytes))
                publishDraft()
            }
        }).catch((error: unknown) => {
            if (!controller.signal.aborted) props.onError(error)
        }).finally(() => {
            if (activeClipboardReadRef.current === controller) {
                activeClipboardReadRef.current = undefined
            }
        })
    }

    const handlePaste = (event: PasteEvent): void => {
        if (event.metadata?.kind !== "binary") return
        event.preventDefault()
        event.stopPropagation()
        if (!isSupportedImageMime(event.metadata.mimeType)) {
            props.onError(new Error(
                `Unsupported binary paste type: ${event.metadata.mimeType ?? "unknown"}`,
            ))
            return
        }
        try {
            insertImage(event.metadata.mimeType!, event.bytes)
        } catch (error) {
            props.onError(error)
        }
    }

    const handleKeyDown = (key: KeyEvent): void => {
        if (props.blocked) {
            key.preventDefault()
            key.stopPropagation()
            return
        }

        const inputAction = buliKeyboardShortcuts.resolve("input", key)
        if (inputAction === "input.pasteClipboard" && props.clipboard) {
            key.preventDefault()
            key.stopPropagation()
            pasteClipboard()
            return
        }
        if (inputAction === "input.followUp") {
            key.preventDefault()
            key.stopPropagation()
            submitInput("followUp")
            return
        }

        if (!props.menuOpen) return

        const action = buliKeyboardShortcuts.resolve("menu", key)
        if (!action) return

        key.preventDefault()
        key.stopPropagation()

        if (action === "menu.previous") props.onMoveMenuSelection(-1)
        if (action === "menu.next") props.onMoveMenuSelection(1)
        if (action === "menu.activate") activateSelectedMenuItem()
    }

    return (
        <box
            width="100%"
            border={["top", "bottom"]}
            borderStyle="single"
            style={{
                minHeight: CHAT_MIN_ROW_COUNT,
                maxHeight: CHAT_MAX_ROW_COUNT,
            }}
        >
            {/* Cell occupancy is Vim-style; editors need half-open selections. */}
            <textarea
                ref={textAreaRef}
                initialValue={props.value.text}
                selectionOccupancy="boundary"
                onSubmit={() => submitInput("auto")}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onContentChange={() => {
                    const input = currentDraft()
                    if (!sameUserInput(input, props.getCurrentValue())) publishDraft()
                }}
                onCursorChange={publishDraft}
                focused={!props.blocked}
                style={{ keyBindings: chatTextAreaKeybindings }}
            />
        </box>
    )
}

function nextImageNumber(input: UserInputContent): number {
    return (input.attachments ?? []).reduce((maximum, attachment) => {
        const match = /^\[Image (\d+)\]$/.exec(attachment.source.value)
        return Math.max(maximum, Number(match?.[1] ?? 0))
    }, 0) + 1
}

function decodedBase64Bytes(data: string): number {
    const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0
    return data.length / 4 * 3 - padding
}

function buildDraft(
    textArea: TextareaRenderable,
    records: readonly ITrackedPathReference[],
    attachmentRecords: readonly ITrackedImageAttachment[],
): UserInputContent {
    const references = records.flatMap((record): UserPathReference[] => {
        const mark = textArea.extmarks.get(record.markId)
        if (
            !mark
            || mark.data !== record.token
            || mark.start < 0
            || mark.end <= mark.start
        ) return []
        if (textArea.editBuffer.getTextRange(mark.start, mark.end) !== record.value) {
            return []
        }
        return [{
            ...record.reference,
            source: {
                value: record.value,
                start: mark.start,
                end: mark.end,
            },
        }]
    })
    const attachments = attachmentRecords.flatMap(
        (record): UserImageAttachment[] => {
            const mark = textArea.extmarks.get(record.markId)
            if (
                !mark
                || mark.data !== record.token
                || mark.start < 0
                || mark.end <= mark.start
            ) return []
            if (
                textArea.editBuffer.getTextRange(mark.start, mark.end)
                !== record.value
            ) return []
            return [{
                ...record.attachment,
                source: {
                    value: record.value,
                    start: mark.start,
                    end: mark.end,
                },
            }]
        },
    )
    return {
        text: textArea.plainText,
        ...(references.length ? { references } : {}),
        ...(attachments.length ? { attachments } : {}),
    }
}

function restoreImageAttachments(
    textArea: TextareaRenderable,
    input: UserInputContent,
    nextToken: { current: number },
): ITrackedImageAttachment[] {
    void textArea.extmarks
    return (input.attachments ?? []).flatMap((attachment) => {
        const { source } = attachment
        if (
            source.start < 0
            || source.end <= source.start
            || textArea.editBuffer.getTextRange(source.start, source.end)
                !== source.value
        ) return []
        const token = nextToken.current
        nextToken.current += 1
        return [{
            markId: textArea.extmarks.create({
                start: source.start,
                end: source.end,
                virtual: true,
                data: token,
            }),
            token,
            value: source.value,
            attachment: {
                type: "image" as const,
                mimeType: attachment.mimeType,
                data: attachment.data,
                filename: attachment.filename,
            },
        }]
    })
}

function restorePathReferences(
    textArea: TextareaRenderable,
    input: UserInputContent,
    nextToken: { current: number },
): ITrackedPathReference[] {
    void textArea.extmarks
    return (input.references ?? []).flatMap((reference) => {
        const { source } = reference
        if (
            source.start < 0
            || source.end <= source.start
            || textArea.editBuffer.getTextRange(source.start, source.end)
                !== source.value
        ) return []
        const token = nextToken.current
        nextToken.current += 1
        return [{
            markId: textArea.extmarks.create({
                start: source.start,
                end: source.end,
                virtual: true,
                data: token,
            }),
            token,
            value: source.value,
            reference: {
                type: "path" as const,
                kind: reference.kind,
                path: reference.path,
            },
        }]
    })
}
