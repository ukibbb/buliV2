import type {
    IAgentDeclaration,
    IAgentDefinition,
} from "@/agent/definition"

/** Binds a reusable declaration to application-owned dependencies. */
export function createAgentDefinition<TDependencies>(
    declaration: IAgentDeclaration<TDependencies>,
    dependencies: TDependencies,
): IAgentDefinition {
    const names = new Set<string>()
    for (const tool of declaration.tools) {
        if (names.has(tool.name)) {
            throw new Error(`Duplicate agent tool: ${tool.name}`)
        }
        names.add(tool.name)
    }

    const tools = declaration.tools.map((tool) => {
        const instance = tool.create(dependencies)
        if (instance.name !== tool.name) {
            throw new Error(
                `Agent tool name mismatch: expected ${tool.name}, received ${instance.name}`,
            )
        }
        return instance
    })

    const toolInstructions = declaration.tools.flatMap(
        (tool) => tool.instructions,
    )
    const systemPrompt = [
        declaration.instructions,
        `Active tools: ${[...names].join(", ") || "none"}.`,
        ...(toolInstructions.length === 0
            ? []
            : ["<tools>", ...toolInstructions, "</tools>"]),
    ].join("\n")

    return {
        id: declaration.id,
        name: declaration.name,
        systemPrompt,
        tools,
    }
}
