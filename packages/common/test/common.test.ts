import { expect, test } from "bun:test";

test("@buli/common resolves through its package export", async () => {
  expect(await import("@buli/common")).toBeDefined();
});
