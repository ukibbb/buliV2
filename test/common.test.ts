import { expect, test } from "bun:test";

import { generateRandomId } from "@/common";

test("@/common resolves through the root alias", async () => {
  expect(await import("@/common")).toBeDefined();
});

test("generates random IDs", () => {
  const first = generateRandomId();
  const second = generateRandomId();

  expect(typeof first).toBe("string");
  expect(first).not.toBe(second);
});
