import { expect, test } from "bun:test";
import packageMetadata from "../package.json" with { type: "json" };

test("prints the package version", async () => {
  const versionProcess = Bun.spawn({
    cmd: ["bun", "cli/main.ts", "--version"],
    cwd: import.meta.dir + "/..",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(versionProcess.stdout).text(),
    new Response(versionProcess.stderr).text(),
    versionProcess.exited,
  ]);

  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  expect(stdout.trim()).toBe(packageMetadata.version);
});

test("prints formatted help instead of the raw yargs instance", async () => {
  const helpProcess = Bun.spawn({
    cmd: ["bun", "cli/main.ts", "--help"],
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
  expect(output).toContain("buli login");
  expect(output).toContain("buli logout");
  expect(output).toContain("--help");
  expect(output).not.toContain("buli tui");
  expect(output).not.toContain("tui [project]");
  expect(output).not.toContain("YargsInstance");
});

test.each(["login", "logout"])(
  "%s help exits without starting OpenTUI",
  async (command) => {
    const helpProcess = Bun.spawn({
      cmd: ["bun", "cli/main.ts", command, "--help"],
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
    expect(output).toContain(`buli ${command}`);
    expect(output).toContain("--help");
    expect(output).not.toContain("OpenTUI");
    expect(output).not.toContain("Loading providers");
  },
);

test("does not accept a positional provider shortcut", async () => {
  const loginProcess = Bun.spawn({
    cmd: ["bun", "cli/main.ts", "login", "openai"],
    cwd: import.meta.dir + "/..",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(loginProcess.stdout).text(),
    new Response(loginProcess.stderr).text(),
    loginProcess.exited,
  ]);
  const output = stdout + stderr;

  expect(exitCode).toBe(1);
  expect(output).toContain("Unknown argument: openai");
  expect(output).not.toContain("OpenTUI");
});

test("does not expose an explicit buli tui command", async () => {
  const tuiProcess = Bun.spawn({
    cmd: ["bun", "cli/main.ts", "tui"],
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
