import { expect, test } from "bun:test"

import { BuliKeyboardController } from "@/tui/keyboard-controller"

test("resolves keyboard actions by scope and exact modifiers", () => {
  const keyboard = new BuliKeyboardController()

  expect(keyboard.resolve("global", { name: "escape" })).toBe("cancel")
  expect(keyboard.resolve("global", { name: "d", ctrl: true })).toBe("console.toggle")
  expect(keyboard.resolve("command-menu", { name: "up" })).toBe("command.previous")
  expect(keyboard.resolve("command-menu", { name: "down" })).toBe("command.next")
  expect(keyboard.resolve("command-menu", { name: "return" })).toBe("command.execute")
  expect(keyboard.resolve("global", { name: "up" })).toBeUndefined()
  expect(keyboard.resolve("command-menu", { name: "up", ctrl: true })).toBeUndefined()
})
