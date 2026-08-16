import { expect, test } from "bun:test"

import { BuliKeyboardController } from "@/tui/keyboard-controller"

test("resolves keyboard actions by scope and exact modifiers", () => {
  const keyboard = new BuliKeyboardController()

  expect(keyboard.resolve("global", { name: "escape" })).toBe("cancel")
  expect(keyboard.resolve("global", { name: "d", ctrl: true })).toBe("console.toggle")
  expect(keyboard.resolve("menu", { name: "up" })).toBe("menu.previous")
  expect(keyboard.resolve("menu", { name: "down" })).toBe("menu.next")
  expect(keyboard.resolve("menu", { name: "return" })).toBe("menu.activate")
  expect(keyboard.resolve("input", { name: "return", meta: true })).toBe(
    "input.followUp",
  )
  expect(keyboard.resolve("input", {
    name: "return",
    meta: true,
    option: true,
  })).toBe("input.followUp")
  expect(keyboard.resolve("input", { name: "kpenter", meta: true })).toBe(
    "input.followUp",
  )
  expect(keyboard.resolve("input", {
    name: "kpenter",
    meta: true,
    option: true,
  })).toBe("input.followUp")
  expect(keyboard.resolve("input", { name: "return" })).toBeUndefined()
  expect(keyboard.resolve("global", { name: "up" })).toBeUndefined()
  expect(keyboard.resolve("global", { name: "tab" })).toBeUndefined()
  expect(keyboard.resolve("menu", { name: "up", ctrl: true })).toBeUndefined()
})
