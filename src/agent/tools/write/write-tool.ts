import { Buffer } from "node:buffer"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { Type } from "typebox"

import { defineAgentTool, type IAgentTool } from "@/agent/tool"
import {
    withFileMutationQueue,
} from "@/agent/tools/shared/file-mutation"
import { createFileWriteResult } from "@/agent/tools/shared/file-write-result"
import { resolveToCwd } from "@/agent/tools/shared/path-utils"

// Ported from Pi 6c87d9a026677b601e8278030dcf1ad97fe0bd86 (c) 2025 Mario Zechner, MIT License.
const WRITE_INPUT_SCHEMA = Type.Object({
    path: Type.String({
        description: "Path to the file to write (relative or absolute)",
    }),
    content: Type.String({ description: "Content to write to the file" }),
})

/** Creates Pi's direct file creation and overwrite tool for one working directory. */
export function createWriteTool(
    cwd: string,
): IAgentTool<typeof WRITE_INPUT_SCHEMA, "write"> {
    return defineAgentTool({
        name: "write",
        description:
            "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
        inputSchema: WRITE_INPUT_SCHEMA,
        execute: async ({ path, content }, context) => {
            const absolutePath = resolveToCwd(path, cwd)
            const directory = dirname(absolutePath)

            return await withFileMutationQueue(absolutePath, async () => {
                const throwIfAborted = (): void => {
                    if (context.signal.aborted) {
                        throw new Error("Operation aborted")
                    }
                }

                throwIfAborted()
                const baseContent = await readOptionalFile(absolutePath)
                throwIfAborted()

                await mkdir(directory, { recursive: true })
                throwIfAborted()

                try {
                    await writeFile(absolutePath, content, "utf-8")
                } catch (error) {
                    throw Object.assign(
                        new Error(`Could not complete writing file: ${path}.`, { cause: error }),
                        { sideEffectsUnknown: true },
                    )
                }

                return createFileWriteResult({
                    path,
                    before: baseContent,
                    after: content,
                    content: `Successfully wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path}`,
                    signal: context.signal,
                })
            })
        },
    })
}

async function readOptionalFile(path: string): Promise<string | undefined> {
    try {
        return await readFile(path, "utf-8")
    } catch (error) {
        if (
            error instanceof Error
            && "code" in error
            && error.code === "ENOENT"
        ) {
            return undefined
        }
        throw error
    }
}
