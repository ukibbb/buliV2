import { expect, test } from "bun:test"

import {
  buliKeyboardShortcuts,
  resolveApprovalKeyboardAction,
} from "@/tui/app/keyboard-shortcuts"
import { authenticationKeyboardShortcuts } from "@/tui/authentication/keyboard-shortcuts"

test("resolves keyboard actions by scope and exact modifiers", () => {
  const keyboard = buliKeyboardShortcuts

  expect(keyboard.resolve("global", { name: "escape" })).toBe("cancel")
  expect(keyboard.resolve("global", { name: "d", ctrl: true })).toBe("console.toggle")
  expect(keyboard.resolve("approval", { name: "up" })).toBe("approval.previous")
  expect(keyboard.resolve("approval", { name: "left" })).toBe("approval.previous")
  expect(keyboard.resolve("approval", { name: "down" })).toBe("approval.next")
  expect(keyboard.resolve("approval", { name: "right" })).toBe("approval.next")
  expect(keyboard.resolve("approval", { name: "return" })).toBe("approval.activate")
  expect(keyboard.resolve("approval", { name: "enter" })).toBe("approval.activate")
  expect(keyboard.resolve("approval", { name: "linefeed" })).toBe("approval.activate")
  expect(keyboard.resolve("approval", { name: "pageup" })).toBe(
    "approval.scrollUp",
  )
  expect(keyboard.resolve("approval", { name: "pagedown" })).toBe(
    "approval.scrollDown",
  )
  expect(keyboard.resolve("approval", { name: "home" })).toBe(
    "approval.scrollStart",
  )
  expect(keyboard.resolve("approval", { name: "end" })).toBe(
    "approval.scrollEnd",
  )
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
  expect(keyboard.resolve("approval", { name: "y" })).toBeUndefined()
  expect(keyboard.resolve("approval", { name: "n" })).toBeUndefined()
  expect(keyboard.resolve("approval", { name: "c" })).toBeUndefined()
  expect(keyboard.resolve("approval", { name: "down", ctrl: true })).toBeUndefined()
  expect(keyboard.resolve("approval", { name: "pagedown", shift: true }))
    .toBeUndefined()
  expect(keyboard.resolve("approval", { name: "return", shift: true })).toBeUndefined()
  expect(keyboard.resolve("menu", { name: "up", ctrl: true })).toBeUndefined()
})

test("resolves only modal review, navigation, and activation for approvals", () => {
  expect(resolveApprovalKeyboardAction({ name: "left" })).toBe(
    "approval.previous",
  )
  expect(resolveApprovalKeyboardAction({ name: "right" })).toBe(
    "approval.next",
  )
  expect(resolveApprovalKeyboardAction({ name: "linefeed" })).toBe(
    "approval.activate",
  )
  expect(resolveApprovalKeyboardAction({ name: "pageup" })).toBe(
    "approval.scrollUp",
  )
  expect(resolveApprovalKeyboardAction({ name: "pagedown" })).toBe(
    "approval.scrollDown",
  )
  expect(resolveApprovalKeyboardAction({ name: "y" })).toBeUndefined()
  expect(resolveApprovalKeyboardAction({ name: "n" })).toBeUndefined()
  expect(resolveApprovalKeyboardAction({ name: "c" })).toBeUndefined()
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
