import { expect, test } from "bun:test"

import { systemPrompt } from "@/agent/system-prompt"
import type { IAgentToolDescriptor } from "@/agent/tool"

const descriptor = (name: string): IAgentToolDescriptor => ({
  name,
  description: `${name} description`,
  inputSchema: { type: "object" },
})

test("builds pair-programming instructions from active capabilities", () => {
  const prompt = systemPrompt("/workspace", [
    descriptor("read"),
    descriptor("glob"),
    descriptor("grep"),
    descriptor("apply_patch"),
    descriptor("bash"),
  ])

  expect(prompt).toContain("Aktywne narzędzia: read, glob, grep, apply_patch, bash.")
  expect(prompt).toContain("Nie jesteś autonomicznym wykonawcą")
  expect(prompt).toContain("Domyślnie użytkownik zachowuje ownership kodu")
  expect(prompt).toContain("apply_patch wolno wywołać tylko po jawnej prośbie")
  expect(prompt).toContain("Kontekst patcha kopiuj dokładnie z wyniku read")
  expect(prompt).toContain("małe, precyzyjnie zakotwiczone chunki")
  expect(prompt).toContain("samo wywołanie nie zmienia plików")
  expect(prompt).toContain("dopiero osobne Apply w UI")
  expect(prompt).toContain("Copy / Run once / Reject")
  expect(prompt).toContain("/bin/bash --noprofile --norc")
  expect(prompt).toContain("ustaw path w glob lub grep bezpośrednio na node_modules/<nazwa-pakietu>")
  expect(prompt).not.toContain("read_file")
})

test("does not claim unavailable tool capabilities", () => {
  const prompt = systemPrompt("/workspace", [descriptor("review")])

  expect(prompt).toContain("Aktywne narzędzia: review.")
  expect(prompt).not.toContain("Do znajdowania plików używaj glob")
  expect(prompt).not.toContain("apply_patch wolno wywołać")
  expect(prompt).not.toContain("Wywołanie Bash")
})
