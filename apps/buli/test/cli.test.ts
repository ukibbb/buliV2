import { expect, test } from "bun:test";

test("prints formatted help instead of the raw yargs instance", async () => {
  const helpProcess = Bun.spawn({
    cmd: ["bun", "src/main.ts", "--help"],
    cwd: import.meta.dir + "/..",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(helpProcess.stdout).text(),
    new Response(helpProcess.stderr).text(),
    helpProcess.exited,
  ]);
  const output = stdout + stderr;

  expect(exitCode).toBe(0);
  expect(output).toContain("buli");
  expect(output).toContain("--help");
  expect(output).not.toContain("buli tui");
  expect(output).not.toContain("tui [project]");
  expect(output).not.toContain("YargsInstance");
});

test("does not expose an explicit buli tui command", async () => {
  const tuiProcess = Bun.spawn({
    cmd: ["bun", "src/main.ts", "tui"],
    cwd: import.meta.dir + "/..",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(tuiProcess.stdout).text(),
    new Response(tuiProcess.stderr).text(),
    tuiProcess.exited,
  ]);
  const output = stdout + stderr;

  expect(exitCode).toBe(1);
  expect(output).toContain("`buli tui` is not a supported command yet");
  expect(output).not.toContain("OpenTUI");
});
