import { expect, test } from "bun:test";

test("@/common resolves through the root alias", async () => {
  expect(await import("@/common")).toBeDefined();
});
