/** Performs bounded structural checks before image bytes enter durable history. */
export function isValidUserImage(
    mimeType: string,
    bytes: Uint8Array,
): boolean {
    const startsWith = (...signature: number[]): boolean => signature.every(
        (byte, index) => bytes[index] === byte,
    )
    if (mimeType === "image/png") {
        return bytes.byteLength >= 33
            && startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
            && bytes[12] === 0x49
            && bytes[13] === 0x48
            && bytes[14] === 0x44
            && bytes[15] === 0x52
            && readUint32(bytes, 16) > 0
            && readUint32(bytes, 20) > 0
            && hasPngEnd(bytes)
    }
    if (mimeType === "image/jpeg") {
        return bytes.byteLength >= 4
            && startsWith(0xff, 0xd8, 0xff)
            && bytes.at(-2) === 0xff
            && bytes.at(-1) === 0xd9
    }
    if (mimeType === "image/gif") {
        const header = startsWith(0x47, 0x49, 0x46, 0x38, 0x37, 0x61)
            || startsWith(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)
        return bytes.byteLength >= 14
            && header
            && (Number(bytes[6]) | (Number(bytes[7]) << 8)) > 0
            && (Number(bytes[8]) | (Number(bytes[9]) << 8)) > 0
            && bytes.at(-1) === 0x3b
    }
    if (mimeType === "image/webp") {
        return bytes.byteLength >= 16
            && startsWith(0x52, 0x49, 0x46, 0x46)
            && bytes[8] === 0x57
            && bytes[9] === 0x45
            && bytes[10] === 0x42
            && bytes[11] === 0x50
            && readUint32LittleEndian(bytes, 4) + 8 === bytes.byteLength
    }
    return false
}

function hasPngEnd(bytes: Uint8Array): boolean {
    const offset = bytes.byteLength - 12
    return bytes[offset] === 0
        && bytes[offset + 1] === 0
        && bytes[offset + 2] === 0
        && bytes[offset + 3] === 0
        && bytes[offset + 4] === 0x49
        && bytes[offset + 5] === 0x45
        && bytes[offset + 6] === 0x4e
        && bytes[offset + 7] === 0x44
}

function readUint32(bytes: Uint8Array, offset: number): number {
    return (
        Number(bytes[offset]) * 0x1000000
        + (Number(bytes[offset + 1]) << 16)
        + (Number(bytes[offset + 2]) << 8)
        + Number(bytes[offset + 3])
    ) >>> 0
}

function readUint32LittleEndian(bytes: Uint8Array, offset: number): number {
    return (
        Number(bytes[offset])
        + (Number(bytes[offset + 1]) << 8)
        + (Number(bytes[offset + 2]) << 16)
        + Number(bytes[offset + 3]) * 0x1000000
    ) >>> 0
}
