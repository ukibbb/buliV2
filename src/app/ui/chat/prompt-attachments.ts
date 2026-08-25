import { Buffer } from "node:buffer"

import type { IUserImageAttachment } from "@/agent"
import {
    isValidUserImage,
    USER_IMAGE_MAX_BYTES,
} from "@/agent"

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
}

export interface IPreparedImageAttachment {
    readonly value: string
    readonly attachment: Omit<IUserImageAttachment, "source">
}

export function prepareClipboardImage(
    mimeType: string,
    bytes: Uint8Array,
    number: number,
): IPreparedImageAttachment {
    const mime = mimeType.toLowerCase()
    const extension = IMAGE_EXTENSIONS[mime]
    if (!extension) throw new Error(`Unsupported clipboard image type: ${mimeType}`)
    if (bytes.byteLength === 0) throw new Error("Clipboard image is empty")
    if (bytes.byteLength > USER_IMAGE_MAX_BYTES) {
        throw new Error("Clipboard image exceeds the 5 MiB limit")
    }
    if (!isValidUserImage(mime, bytes)) {
        throw new Error(`Clipboard bytes do not match ${mime}`)
    }

    const value = `[Image ${number}]`
    return {
        value,
        attachment: {
            type: "image",
            mimeType: mime,
            data: Buffer.from(bytes).toString("base64"),
            filename: `clipboard-${number}.${extension}`,
        },
    }
}

export function isSupportedImageMime(mimeType: string | undefined): boolean {
    return mimeType !== undefined
        && Object.hasOwn(IMAGE_EXTENSIONS, mimeType.toLowerCase())
}
