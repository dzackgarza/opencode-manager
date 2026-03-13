#!/usr/bin/env bun
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import {
  renderTranscriptMarkdown,
  type TranscriptExport,
} from "./transcript";
import {
  renderInputTranscript,
  renderSessionTranscript,
} from "./session-harness";

type TranscriptCliArgs = {
  input?: string;
  opencodeBin?: string;
  output?: string;
  sessionID?: string;
  teeTemp: boolean;
};

function printHelp(): void {
  console.log(`
OpenCode transcript renderer

Usage:
  opencode-transcript <session-id> [--output PATH | --tee-temp]
  opencode-transcript --input <export.json> [--output PATH | --tee-temp]
  opencode-transcript <session-id> --opencode-bin /path/to/opencode [--output PATH | --tee-temp]

Behavior:
  By default, session IDs are rendered through the configured OpenCode server.
  Use --opencode-bin to force \`opencode export\` compatibility mode instead.

Options:
  --input PATH        Render a saved \`opencode export\` JSON file
  --opencode-bin BIN  Export with BIN instead of using the server API
  --output PATH       Save transcript to a file instead of streaming
  --tee-temp          Stream transcript and also save it to a temp file
  --help              Show this help
`);
}

function parseArgs(argv: string[]): TranscriptCliArgs {
  const positional: string[] = [];
  const parsed: TranscriptCliArgs = { teeTemp: false };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      case "--input":
        parsed.input = argv[index + 1];
        index += 1;
        break;
      case "--opencode-bin":
        parsed.opencodeBin = argv[index + 1];
        index += 1;
        break;
      case "--output":
        parsed.output = argv[index + 1];
        index += 1;
        break;
      case "--tee-temp":
        parsed.teeTemp = true;
        break;
      default:
        if (token.startsWith("--")) {
          throw new Error(`Unknown option: ${token}`);
        }
        positional.push(token);
        break;
    }
  }

  if (positional.length > 1) {
    throw new Error("Provide at most one session ID.");
  }

  parsed.sessionID = positional[0];
  return parsed;
}

async function loadTranscriptExportFromOpencode(
  sessionID: string,
  opencodeBin: string,
): Promise<TranscriptExport> {
  const proc = Bun.spawn([opencodeBin, "export", sessionID], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(
      stderr.trim() || `${opencodeBin} export ${sessionID} exited with ${exitCode}`,
    );
  }

  return JSON.parse(stdout) as TranscriptExport;
}

function teeLabel(args: TranscriptCliArgs): string {
  if (args.sessionID) {
    return args.sessionID;
  }
  return basename(args.input ?? "transcript.json").replace(/\.[^.]+$/, "");
}

async function renderTranscript(args: TranscriptCliArgs, savedCopyPath?: string) {
  if (args.input) {
    return renderInputTranscript(args.input, { savedCopyPath });
  }

  if (!args.sessionID) {
    throw new Error("A session ID or --input <path> is required.");
  }

  if (args.opencodeBin) {
    const exported = await loadTranscriptExportFromOpencode(
      args.sessionID,
      args.opencodeBin,
    );
    return renderTranscriptMarkdown(exported, { savedCopyPath });
  }

  return renderSessionTranscript(args.sessionID, { savedCopyPath });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.output && args.teeTemp) {
    throw new Error("Use either --output <path> or --tee-temp, not both.");
  }
  if (!!args.sessionID === !!args.input) {
    throw new Error("Provide exactly one of <session-id> or --input <path>.");
  }

  const outputPath = args.output
    ? resolve(args.output)
    : args.teeTemp
      ? join(tmpdir(), `opencode-transcript-${teeLabel(args)}-${Date.now()}.md`)
      : undefined;

  const transcript = await renderTranscript(args, outputPath);

  if (outputPath) {
    await Bun.write(outputPath, transcript);
  }

  if (!args.output || args.teeTemp) {
    process.stdout.write(transcript);
    return;
  }

  console.log(outputPath);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
