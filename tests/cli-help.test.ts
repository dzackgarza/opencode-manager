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
  it("keeps workflow commands at top level", async () => {
    const result = await runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("WORKFLOW COMMANDS:");
    expect(result.stdout).toContain("  start [--title <text>] [--json]");
    expect(result.stdout).toContain("  prompt --session <id> --prompt <text>");
    expect(result.stdout).toContain("Internal surfaces stay behind explicit subcommands");
    expect(result.stdout).not.toContain("SESSION COMMANDS:");
  });

  it("marks opx session as internal on explicit help", async () => {
    const result = await runCli(["session", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("opx session — internal session subcommands");
    expect(result.stdout).toContain("This surface is internal");
  });
});
