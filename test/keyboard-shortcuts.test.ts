import { expect, test } from "bun:test"

import { buliKeyboardShortcuts } from "@/tui/app/keyboard-shortcuts"
import { authenticationKeyboardShortcuts } from "@/tui/authentication/keyboard-shortcuts"

test("resolves keyboard actions by scope and exact modifiers", () => {
  const keyboard = buliKeyboardShortcuts

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

test("resolves authentication shortcuts without owning flow state", () => {
  const keyboard = authenticationKeyboardShortcuts

  expect(keyboard.resolve("flow", { name: "escape" })).toBe("cancel")
  expect(keyboard.resolve("flow", { name: "return" })).toBe("accept")
  expect(keyboard.resolve("flow", { name: "enter" })).toBe("accept")
  expect(keyboard.resolve("flow", { name: "linefeed" })).toBe("accept")
  expect(keyboard.resolve("flow", { name: "pageup" })).toBe("scroll.up")
  expect(keyboard.resolve("flow", { name: "pagedown" })).toBe("scroll.down")
  expect(keyboard.resolve("flow", { name: "kpenter" })).toBeUndefined()
  expect(keyboard.resolve("flow", {
    name: "escape",
    ctrl: true,
  })).toBeUndefined()
})
