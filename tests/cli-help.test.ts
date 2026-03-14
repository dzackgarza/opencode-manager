import { describe, expect, it } from "bun:test";

async function runCli(args: string[]) {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    cwd: import.meta.dir + "/..",
    stderr: "pipe",
    stdout: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

describe("opx help surface", () => {
  it("shows only the redesigned workflow commands at top level", async () => {
    const result = await runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("WORKFLOW COMMANDS:");
    expect(result.stdout).toContain("  one-shot --prompt <text>");
    expect(result.stdout).toContain(
      "  begin-session <prompt> [--agent <name>] [--model provider/model] [--json]",
    );
    expect(result.stdout).toContain("  chat --session <id> --prompt <text>");
    expect(result.stdout).toContain("  system --session <id> --prompt <text>");
    expect(result.stdout).toContain("  final --session <id> --prompt <text>");
    expect(result.stdout).toContain("Run `opx advanced --help`");
    expect(result.stdout).toContain("Run `opx debug --help`");
    expect(result.stdout).not.toContain("start [--title <text>] [--json]");
    expect(result.stdout).not.toContain("prompt --session <id> --prompt <text>");
    expect(result.stdout).not.toContain("messages");
    expect(result.stdout).not.toContain("resume");
    expect(result.stdout).not.toContain("opx session");
    expect(result.stdout).not.toContain("opx-session");
  });

  it("layers advanced help separately from the workflow surface", async () => {
    const result = await runCli(["advanced", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("opx advanced");
    expect(result.stdout).toContain("provider-list");
    expect(result.stdout).toContain("provider-health");
    expect(result.stdout).not.toContain("opx-session");
    expect(result.stdout).not.toContain("session messages");
  });

  it("keeps debug help under an explicit debug layer", async () => {
    const result = await runCli(["debug", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("opx debug");
    expect(result.stdout).toContain("trace");
    expect(result.stdout).toContain("probe-limit");
    expect(result.stdout).not.toContain("opx-session");
  });

  it("removes keep semantics from one-shot help", async () => {
    const result = await runCli(["one-shot", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("return the last assistant message");
    expect(result.stdout).toContain("--transcript");
    expect(result.stdout).not.toContain("--keep");
  });

  it("requires a positional initial prompt for begin-session", async () => {
    const result = await runCli(["begin-session", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("begin-session [options] <prompt>");
    expect(result.stdout).not.toContain("--prompt");
  });

  it("rejects the old empty begin-session form", async () => {
    const result = await runCli(["begin-session"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("missing required argument 'prompt'");
  });
});
