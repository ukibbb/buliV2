import { expect, test } from "bun:test"

import { splitWorkspaceDiff } from "@/tools/ui/workspace-diff"

test("splits every exact workspace diff section without losing input", () => {
  const first = [
    "--- a/src/first.ts",
    "+++ b/src/first.ts",
    "@@ -1,1 +1,1 @@",
    "-old first",
    "+new first",
    "",
  ].join("\n")
  const second = [
    "--- /dev/null",
    "+++ b/src/second.ts",
    "@@ -0,0 +1,1 @@",
    "+new second",
    "",
  ].join("\n")

  const sections = splitWorkspaceDiff(first + second)

  expect(sections).toEqual([
    {
      diff: first,
      label: "src/first.ts",
      filePath: "src/first.ts",
      hasHunks: true,
      hasNoNewlineMetadata: false,
    },
    {
      diff: second,
      label: "Added src/second.ts",
      filePath: "src/second.ts",
      hasHunks: true,
      hasNoNewlineMetadata: false,
    },
  ])
  expect(sections.map((section) => section.diff).join("")).toBe(first + second)
})

test("does not split hunk content that resembles file headers", () => {
  const diff = [
    "--- a/content.txt",
    "+++ b/content.txt",
    "@@ -1,1 +1,1 @@",
    "--- a/not-a-header",
    "+++ b/not-a-header",
    "",
  ].join("\n")

  const sections = splitWorkspaceDiff(diff)

  expect(sections).toEqual([
    {
      diff,
      label: "content.txt",
      filePath: "content.txt",
      hasHunks: true,
      hasNoNewlineMetadata: false,
    },
  ])
})

test("returns no sections for an unrecognized or incomplete diff", () => {
  expect(splitWorkspaceDiff("diff --git a/file b/file\n--- a/file\n+++ b/file\n"))
    .toEqual([])
  expect(splitWorkspaceDiff("--- a/file\n+++ b/file\n@@ -1,1 +1,1 @@\n-old\n"))
    .toEqual([])
  expect(splitWorkspaceDiff(
    "--- a/file\n+++ b/file\n@@ -1,1 +1,1 @@\n\\ No newline at end of file\n-old\n+new\n",
  )).toEqual([])
  expect(splitWorkspaceDiff(
    "--- /dev/null\n+++ /dev/null\n@@ -0,0 +0,0 @@\n",
  )).toEqual([])
  expect(splitWorkspaceDiff(
    "--- /dev/null\n+++ b/file\n@@ -1,1 +1,1 @@\n-old\n+new\n",
  )).toEqual([])
  expect(splitWorkspaceDiff(
    "--- a/file\n+++ b/file\n@@ -0,0 +0,0 @@\n",
  )).toEqual([])
  expect(splitWorkspaceDiff(
    "--- a/file\n+++ b/file\n@@ -1,2 +1,1 @@\n-old\n\\ No newline at end of file\n keep\n",
  )).toEqual([])
  expect(splitWorkspaceDiff(
    "--- a/file\n+++ b/file\n@@ -1,1 +1,1 @@ functionName\n-old\n+new\n",
  )).toEqual([])
  expect(splitWorkspaceDiff(
    "--- a/\n+++ b/file\n@@ -1,1 +1,1 @@\n-old\n+new\n",
  )).toEqual([])
  expect(splitWorkspaceDiff(
    "--- a/file\n+++ b/file\n@@ -0,1 +1,1 @@\n-old\n+new\n",
  )).toEqual([])
  expect(splitWorkspaceDiff([
    "--- a/file",
    "+++ b/file",
    "@@ -2,1 +2,1 @@",
    "-old",
    "+new",
    "@@ -1,1 +1,1 @@",
    "-earlier",
    "+changed",
    "",
  ].join("\n"))).toEqual([])
})

test("keeps valid no-newline markers and header-only file changes exact", () => {
  const noNewlineDiff = [
    "--- a/file",
    "+++ b/file",
    "@@ -1,1 +1,1 @@",
    "-old",
    "\\ No newline at end of file",
    "+new",
    "\\ No newline at end of file",
    "",
  ].join("\n")
  const emptyDeletion = "--- a/empty.txt\n+++ /dev/null"

  expect(splitWorkspaceDiff(noNewlineDiff)).toEqual([{
    diff: noNewlineDiff,
    label: "file",
    filePath: "file",
    hasHunks: true,
    hasNoNewlineMetadata: true,
  }])
  expect(splitWorkspaceDiff(emptyDeletion)).toEqual([{
    diff: emptyDeletion,
    label: "Deleted empty.txt",
    filePath: "empty.txt",
    hasHunks: false,
    hasNoNewlineMetadata: false,
  }])
})

test("does not confuse literal file content with no-newline metadata", () => {
  const diff = [
    "--- a/file",
    "+++ b/file",
    "@@ -1,1 +1,1 @@",
    "-old",
    "+\\ No newline at end of file",
  ].join("\n")

  expect(splitWorkspaceDiff(diff)).toEqual([{
    diff,
    label: "file",
    filePath: "file",
    hasHunks: true,
    hasNoNewlineMetadata: false,
  }])
})
