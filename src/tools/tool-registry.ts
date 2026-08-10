import type { TJsonObject, TJsonValue } from "@/domain"

export interface IToolExecutionContext {
  readonly workspaceRoot: string
  readonly signal: AbortSignal
}

export interface IBuliToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: TJsonObject
  readonly execute: (
    input: TJsonObject,
    context: IToolExecutionContext,
  ) => Promise<TJsonValue>
}

/** Stores provider-neutral tool definitions and executes them by name. */
export class BuliToolRegistry {
  private readonly tools = new Map<string, IBuliToolDefinition>()

  constructor(definitions: readonly IBuliToolDefinition[]) {
    for (const definition of definitions) {
      if (this.tools.has(definition.name)) {
        throw new Error(`Duplicate tool definition: ${definition.name}`)
      }

      this.tools.set(definition.name, definition)
    }
  }

  definitions(): readonly IBuliToolDefinition[] {
    return [...this.tools.values()]
  }

  async execute(
    name: string,
    input: TJsonObject,
    context: IToolExecutionContext,
  ): Promise<TJsonValue> {
    const definition = this.tools.get(name)
    if (!definition) throw new Error(`Unknown tool: ${name}`)

    context.signal.throwIfAborted()
    const output = await definition.execute(structuredClone(input), context)
    context.signal.throwIfAborted()
    return structuredClone(output)
  }
}
