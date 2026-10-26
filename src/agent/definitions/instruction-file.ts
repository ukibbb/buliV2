/** One instruction file loaded at startup and included in the agents' model instructions. */
export interface IInstructionFile {
    readonly source: string
    readonly content: string
}
