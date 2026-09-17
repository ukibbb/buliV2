import type { IRuntimeAgentTool } from "@/agent/tool"

/** Reusable tool declaration, instantiated with application-owned dependencies. */
export interface IAgentToolDeclaration<TDependencies> {
    readonly name: string
    readonly instructions: readonly string[]
    readonly create: (dependencies: TDependencies) => IRuntimeAgentTool
}

/** Agent role and selected tools, before binding them to a workspace. */
export interface IAgentDeclaration<TDependencies> {
    readonly id: string
    readonly name: string
    readonly instructions: string
    readonly tools: readonly IAgentToolDeclaration<TDependencies>[]
}

/** Agent identity and behavior, independent of a conversation's live state. */
export interface IAgentDefinition {
    readonly id: string
    readonly name: string
    readonly systemPrompt: string
    readonly tools: readonly IRuntimeAgentTool[]
}
