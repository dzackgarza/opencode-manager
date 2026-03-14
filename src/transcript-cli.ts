#!/usr/bin/env bun
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import {
  renderInputTranscript,
  renderSessionTranscript,
} from "./session-harness";

type TranscriptCliArgs = {
  input?: string;
  json: boolean;
  output?: string;
  sessionID?: string;
  teeTemp: boolean;
};

function printHelp(): void {
  console.log(`
OpenCode transcript renderer

Usage:
  opencode-transcript <session-id> [--json] [--output PATH | --tee-temp]
  opencode-transcript --input <transcript.json> [--json] [--output PATH | --tee-temp]

Options:
  --input PATH        Render a saved transcript JSON file
  --json              Emit compact structured JSON instead of markdown
  --output PATH       Save transcript to a file instead of streaming
  --tee-temp          Stream transcript and also save it to a temp file
  --help              Show this help
`);
}

function parseArgs(argv: string[]): TranscriptCliArgs {
  const positional: string[] = [];
  const parsed: TranscriptCliArgs = { json: false, teeTemp: false };

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
      case "--json":
        parsed.json = true;
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

function teeLabel(args: TranscriptCliArgs): string {
  if (args.sessionID) {
    return args.sessionID;
  }
  return basename(args.input ?? "transcript.json").replace(/\.[^.]+$/, "");
}

async function renderTranscript(args: TranscriptCliArgs, savedCopyPath?: string) {
  if (args.input) {
    return renderInputTranscript(args.input, {
      json: args.json,
      savedCopyPath,
    });
  }

  if (!args.sessionID) {
    throw new Error("A session ID or --input <path> is required.");
  }

  return renderSessionTranscript(args.sessionID, {
    json: args.json,
    savedCopyPath,
  });
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
      ? join(
          tmpdir(),
          `opencode-transcript-${teeLabel(args)}-${Date.now()}.${
            args.json ? "json" : "md"
          }`,
        )
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
