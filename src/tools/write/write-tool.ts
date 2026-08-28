import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { Type } from "typebox"

import type { IAgentTool } from "@/agent"
import {
    withFileMutationQueue,
} from "@/tools/shared/file-mutation"
import { resolveToCwd } from "@/tools/shared/path-utils"

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
): IAgentTool<typeof WRITE_INPUT_SCHEMA> {
    return {
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
                await mkdir(directory, { recursive: true })
                throwIfAborted()

                await writeFile(absolutePath, content, "utf-8")
                throwIfAborted()

                return `Successfully wrote ${content.length} bytes to ${path}`
            })
        },
    }
}
