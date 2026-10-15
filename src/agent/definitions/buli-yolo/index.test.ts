import { expect, test } from "bun:test"
import { createBuliYoloAgentDefinition } from "./index"

test("Buli YOLO is a separate definition sharing Buli tools and quality rules", () => {
    const buli = { id: "buli", name: "Buli", systemPrompt: "Base agent instructions", tools: [] }
    const yolo = createBuliYoloAgentDefinition(buli)
    expect(yolo.id).toBe("buli-yolo")
    expect(yolo.tools).toBe(buli.tools)
    expect(yolo.systemPrompt).toStartWith(buli.systemPrompt)
    expect(buli.systemPrompt).not.toContain("Agent: Buli YOLO")
    expect(yolo.systemPrompt).toContain("Raport jest częścią zadania")
    expect(yolo.systemPrompt).toContain("Samo włączenie trybu nie zatwierdza zadania")
    expect(yolo.systemPrompt).toContain("Nie osłabiaj kryteriów ukończenia")
})
