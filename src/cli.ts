#!/usr/bin/env bun
import { createOpencodeClient } from "@opencode-ai/sdk";
import { spawn } from "child_process";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { renderSessionTranscript } from "./session-harness";

const REQUEST_TIMEOUT_MS = 180000;
let RESOLVED_BASE_URL = "http://127.0.0.1:4096";
let AUTH_HEADER = "";

type KV = Record<string, string | boolean>;

type KnownLimitPattern = {
  providerID: string;
  modelID: string;
  match_regex: string;
  normalized_kind: "rate_limit";
  example_expected_substring: string;
};

type SessionContext = {
  directory?: string;
  workspaceID?: string;
};

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  command: string;
  subcommand: string;
  args: KV;
} {
  const [command = "help", maybeSubcommand = "", ...rest] = argv;

  // Commands that have subcommands: session, provider, debug
  const hasSubcommands = ["session", "provider", "debug"].includes(command);
  let subcommand = "";
  let restArgs: string[];

  if (hasSubcommands && maybeSubcommand && !maybeSubcommand.startsWith("--")) {
    subcommand = maybeSubcommand;
    restArgs = rest;
  } else {
    restArgs = maybeSubcommand ? [maybeSubcommand, ...rest] : rest;
  }

  const args: KV = {};
  for (let i = 0; i < restArgs.length; i++) {
    const token = restArgs[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = restArgs[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return { command, subcommand, args };
}

function getString(args: KV, key: string, fallback = ""): string {
  const value = args[key];
  if (typeof value === "string") return value;
  return fallback;
}

function hasFlag(args: KV, key: string): boolean {
  return args[key] === true;
}

function parseModel(
  model?: string,
): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const [providerID, ...rest] = model.split("/");
  if (!providerID || rest.length === 0) return undefined;
  return { providerID, modelID: rest.join("/") };
}

// ---------------------------------------------------------------------------
// Text utilities
// ---------------------------------------------------------------------------

function flattenText(parts: Array<any>): string {
  return (parts ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("")
    .trim();
}

function renderTranscript(messages: Array<any>, tailLines: number): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const role = (msg.info?.role ?? "unknown").toUpperCase();
    const text = flattenText(msg.parts ?? []);
    if (!text) continue;
    lines.push(`[${role}]`);
    lines.push(text);
    lines.push("---");
  }
  return lines.slice(-tailLines).join("\n");
}

function renderAssistantText(messages: Array<any>): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.info?.role !== "assistant") continue;
    const text = flattenText(msg.parts ?? []);
    if (!text) continue;
    lines.push(text);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function classifyError(err: any): string {
  const blob = JSON.stringify(err ?? {}).toLowerCase();
  if (
    blob.includes("rate limit") ||
    blob.includes("too many requests") ||
    blob.includes("429")
  )
    return "rate_limit";
  if (
    blob.includes("usage limit") ||
    blob.includes("quota") ||
    blob.includes("credit") ||
    blob.includes("subscription")
  )
    return "quota";
  if (
    blob.includes("forbidden") ||
    blob.includes("permission_denied") ||
    blob.includes("permission")
  )
    return "permission";
  if (blob.includes("aborted")) return "aborted";
  return "other";
}

function summarizeError(err: any): string {
  if (!err) return "";
  if (typeof err.message === "string") return err.message;
  if (typeof err?.data?.message === "string") return err.data.message;
  const txt = JSON.stringify(err);
  return txt.length > 300 ? `${txt.slice(0, 300)}...` : txt;
}

function normalizeErrorRecord(source: string, sessionID: string, info: any) {
  const errorObj = info?.error;
  return {
    source,
    sessionID,
    messageID: info?.id,
    providerID: info?.providerID,
    modelID: info?.modelID,
    agent: info?.agent,
    mode: info?.mode,
    kind: classifyError(errorObj?.data ?? errorObj),
    summary: summarizeError(errorObj?.data ?? errorObj),
    error: errorObj,
  };
}

/** Returns exit code: 0=success, 1=failure, 2=provider-unavailable */
function errorKindToExitCode(kind: string): number {
  if (kind === "rate_limit" || kind === "quota") return 2;
  return 1;
}

// ---------------------------------------------------------------------------
// Service log helpers
// ---------------------------------------------------------------------------

async function readServiceLogLines(
  sessionID: string,
  sinceSec: number,
): Promise<string[]> {
  const cmd = `export XDG_RUNTIME_DIR=\"/run/user/$(id -u)\" DBUS_SESSION_BUS_ADDRESS=\"unix:path=/run/user/$(id -u)/bus\"; journalctl --user -u opencode-serve --since \"${sinceSec} seconds ago\" --no-pager -o cat`;
  return await new Promise<string[]>((resolve) => {
    const child = spawn("bash", ["-lc", cmd], {
      cwd: process.cwd(),
      env: process.env,
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      out += d.toString();
    });
    child.on("close", () => {
      const lines = out
        .split("\n")
        .filter((line) => line.includes(sessionID))
        .filter((line) => {
          const s = line.toLowerCase();
          return (
            s.includes("service=session.processor") ||
            s.includes("service=llm") ||
            s.includes("ai_apicallerror") ||
            s.includes("rate limit") ||
            s.includes("usage limit") ||
            s.includes("quota") ||
            s.includes("subscription") ||
            s.includes("429")
          );
        });
      resolve(lines);
    });
    child.on("error", () => resolve([]));
  });
}

// ---------------------------------------------------------------------------
// Known limit pattern helpers
// ---------------------------------------------------------------------------

async function loadKnownLimitPatterns(): Promise<
  Record<string, KnownLimitPattern>
> {
  const configPath = `${import.meta.dir}/../config/known_limit_patterns.json`;
  const text = await Bun.file(configPath).text();
  return JSON.parse(text) as Record<string, KnownLimitPattern>;
}

async function runOneShotWithLogs(
  model: string,
  prompt: string,
  timeoutSec: number,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const inner = `opencode run --print-logs --log-level DEBUG -m ${JSON.stringify(model)} ${JSON.stringify(prompt)}`;
    const shellCmd = `script -qec ${JSON.stringify(inner)} /dev/null`;
    const child = spawn("bash", ["-lc", shellCmd], {
      cwd: process.cwd(),
      env: process.env,
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutSec * 1000);
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      out += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

function extractKnownLimitEvent(
  raw: string,
  pattern: KnownLimitPattern,
): { matchedLine: string; evidence: string[] } | null {
  const lines = raw.split(/\r\n|\n|\r/g);
  const rx = new RegExp(pattern.match_regex, "i");
  let matchedLine = "";
  for (const line of lines) {
    if (rx.test(line)) {
      matchedLine = line.trim();
      break;
    }
  }
  if (!matchedLine) return null;

  const evidence = lines
    .filter((line) => {
      const s = line.toLowerCase();
      return (
        s.includes(`providerid=${pattern.providerID.toLowerCase()}`) ||
        s.includes(`modelid=${pattern.modelID.toLowerCase()}`) ||
        rx.test(line)
      );
    })
    .map((line) => compactLogLine(line.trim()))
    .filter((line) => {
      if (!line) return false;
      const s = line.toLowerCase();
      return (
        s.includes("service=") ||
        s.includes("providerid=") ||
        s.includes("modelid=") ||
        s.includes("ai_apicallerror") ||
        s.includes("rate limit") ||
        s.includes("status=")
      );
    })
    .slice(-6);

  return {
    matchedLine: compactLogLine(matchedLine),
    evidence,
  };
}

function compactLogLine(line: string, maxLen = 320): string {
  const normalized = line
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/error=\{.*$/i, "error=<omitted>")
    .replace(/responseBody=\".*$/i, 'responseBody="<omitted>')
    .replace(/requestBodyValues=\{.*$/i, "requestBodyValues=<omitted>");
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen - 3)}...`;
}

// ---------------------------------------------------------------------------
// Client / HTTP helpers
// ---------------------------------------------------------------------------

function encodeDirectoryHeader(directory: string): string {
  return /[^\x00-\x7F]/.test(directory)
    ? encodeURIComponent(directory)
    : directory;
}

function applySessionContextHeaders(
  input: Record<string, string>,
  context?: SessionContext | null,
): Record<string, string> {
  const headers = { ...input };
  if (!context) return headers;
  if (context.directory) {
    headers["x-opencode-directory"] = encodeDirectoryHeader(context.directory);
  }
  if (context.workspaceID) {
    headers["x-opencode-workspace"] = context.workspaceID;
  }
  return headers;
}

function sessionSdkOptions(context?: SessionContext | null): {
  headers?: Record<string, string>;
  query?: { directory: string };
} {
  if (!context) {
    return {};
  }

  const headers = applySessionContextHeaders({}, context);
  return {
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(context.directory ? { query: { directory: context.directory } } : {}),
  };
}

function currentSessionContext(): SessionContext {
  return { directory: process.cwd() };
}

function sessionContextFromSession(
  session: { directory?: string; workspaceID?: string } | null | undefined,
): SessionContext | null {
  if (!session) return null;
  if (!session.directory && !session.workspaceID) return null;
  return {
    directory: session.directory,
    workspaceID: session.workspaceID,
  };
}

async function fetchSessionContext(
  sessionID: string,
): Promise<SessionContext | null> {
  const headers: Record<string, string> = {};
  if (AUTH_HEADER) {
    headers.authorization = AUTH_HEADER;
  }
  const response = await fetch(
    `${RESOLVED_BASE_URL}/session/${encodeURIComponent(sessionID)}`,
    {
      headers,
    },
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`session lookup failed (${response.status}): ${text}`);
  }
  const data = (await response.json()) as
    | { directory?: string; workspaceID?: string }
    | null;
  return sessionContextFromSession(data);
}

async function resolveSessionContext(
  sessionID: string,
  context?: SessionContext | null,
): Promise<SessionContext | null> {
  return context ?? (await fetchSessionContext(sessionID));
}

async function makeSessionClient(
  sessionID: string,
  context?: SessionContext | null,
) {
  const resolved = await resolveSessionContext(sessionID, context);
  return {
    context: resolved,
    client: makeClient(),
  };
}

function makeClient() {
  let baseUrl = process.env.OPENCODE_BASE_URL ?? "http://127.0.0.1:4096";
  const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
  const password = process.env.OPENCODE_SERVER_PASSWORD ?? "";

  RESOLVED_BASE_URL = baseUrl;
  AUTH_HEADER = "";

  if (password) {
    const token = Buffer.from(`${username}:${password}`).toString("base64");
    AUTH_HEADER = `Basic ${token}`;
  }

  return createOpencodeClient({ baseUrl });
}

async function promptAsyncRequest(
  sessionID: string,
  body: Record<string, unknown>,
  context?: SessionContext | null,
) {
  const headers = applySessionContextHeaders(
    {
      "content-type": "application/json",
    },
    await resolveSessionContext(sessionID, context),
  );
  if (AUTH_HEADER) headers.authorization = AUTH_HEADER;

  const res = await fetch(
    `${RESOLVED_BASE_URL}/session/${encodeURIComponent(sessionID)}/prompt_async`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`prompt_async failed (${res.status}): ${text}`);
  }
}

// ---------------------------------------------------------------------------
// Transcript generation
// ---------------------------------------------------------------------------

async function generateTranscript(sessionID: string): Promise<string> {
  try {
    return await renderSessionTranscript(sessionID);
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error);
    return `[transcript unavailable for ${sessionID}] ${message}`;
  }
}

// ---------------------------------------------------------------------------
// SSE-driven idle waiter with linger semantics
//
// Linger applies ONLY to idle-1. State machine:
//   running → idle-1 → (linger or re-running → idle-2 → done)
//
// Returns: { exitCode, errorKind, sessionID }
// ---------------------------------------------------------------------------

type WaitResult = {
  exitCode: number;
  errorKind: string | null;
  timedOut: boolean;
};

async function waitForIdle(
  client: any,
  sessionID: string,
  lingerSec: number,
  timeoutSec: number,
  context?: SessionContext | null,
): Promise<WaitResult> {
  const startMs = Date.now();
  const timeoutMs = timeoutSec * 1000;

  // Track error state
  let lastErrorKind: string | null = null;
  let lastExitCode = 0;

  // State machine: "running" | "idle1" | "running2" | "done"
  // Box in an object so TS doesn't narrow the captured variable across closures.
  type State = "running" | "idle1" | "running2" | "done";
  const sm = { state: "running" as State };
  let lingerDeadlineMs = 0;

  // SSE-based idle detection via polling the messages endpoint is unreliable for
  // idle detection. We use the event stream to detect message completion.
  // We track the last message count and whether new assistant messages have arrived
  // to determine idle.

  const controller = new AbortController();
  const hardTimer = setTimeout(() => controller.abort(), timeoutMs);

  let lastMsgCount = 0;
  let lastMsgTimestamp = Date.now();

  // We run two parallel tasks:
  // 1. SSE event listener for message.updated / session.error
  // 2. Periodic poll to detect stable idle (no new messages for 2s)

  // The caller is responsible for passing a client scoped to the session's
  // stored directory/workspace so the event stream matches the live session.
  const stream = await client.event.subscribe({
    signal: controller.signal,
    ...sessionSdkOptions(context),
  });

  const sseCollector = (async () => {
    try {
      for await (const evt of stream.stream as AsyncGenerator<any>) {
        if (!evt || typeof evt !== "object") continue;

        if (evt.type === "message.updated") {
          const info = evt.properties?.info;
          if (!info || info.sessionID !== sessionID) continue;

          // New message activity — we're running
          lastMsgTimestamp = Date.now();

          if (info.role === "assistant") {
            if (info.error) {
              const kind = classifyError(info.error?.data ?? info.error);
              lastErrorKind = kind;
              lastExitCode = errorKindToExitCode(kind);
            }

            // Completed assistant message signals end of a turn
            if (info.time?.completed) {
              if (sm.state === "running") {
                sm.state = "idle1";
                if (lingerSec > 0) {
                  lingerDeadlineMs = Date.now() + lingerSec * 1000;
                } else {
                  sm.state = "done";
                  controller.abort();
                  return;
                }
              } else if (sm.state === "running2") {
                sm.state = "done";
                controller.abort();
                return;
              }
            } else {
              // Active message (not yet completed) — we're in running state
              if (sm.state === "idle1") {
                // Session resumed activity after reaching idle-1
                sm.state = "running2";
                lingerDeadlineMs = 0; // cancel linger
              }
            }
          }
          continue;
        }

        if (evt.type === "session.error") {
          const sid = evt.properties?.sessionID;
          if (sid !== sessionID) continue;
          const kind = classifyError(evt.properties?.error);
          lastErrorKind = kind;
          lastExitCode = errorKindToExitCode(kind);
          sm.state = "done";
          controller.abort();
          return;
        }
      }
    } catch {
      // abort/timeout
    }
  })();

  // Linger/timeout watchdog
  const watchdog = (async () => {
    while (sm.state !== "done") {
      await new Promise((r) => setTimeout(r, 200));
      if (Date.now() - startMs > timeoutMs) break;

      if (sm.state === "idle1" && lingerDeadlineMs > 0) {
        if (Date.now() >= lingerDeadlineMs) {
          sm.state = "done";
          controller.abort();
          break;
        }
      }
    }
  })();

  await Promise.race([sseCollector, watchdog]);
  clearTimeout(hardTimer);
  controller.abort(); // ensure cleanup

  const timedOut = Date.now() - startMs >= timeoutMs && sm.state !== "done";
  if (timedOut) lastExitCode = 1;

  return { exitCode: lastExitCode, errorKind: lastErrorKind, timedOut };
}

// ---------------------------------------------------------------------------
// Public workflow helpers
// ---------------------------------------------------------------------------

async function createWorkflowSession(
  client: any,
  title?: string,
): Promise<{ sessionID: string; context: SessionContext | null; sessionClient: any }> {
  const creationContext = currentSessionContext();
  const created = await client.session.create({
    ...sessionSdkOptions(creationContext),
    body: { title: title || `opx:${Date.now()}` },
  });
  const sessionID = created.data?.id;
  if (!sessionID) throw new Error("Failed to create session");
  const context =
    sessionContextFromSession(created.data) ??
    (await fetchSessionContext(sessionID));
  return { sessionID, context, sessionClient: makeClient() };
}

async function deleteWorkflowSession(
  sessionClient: any,
  sessionID: string,
  context?: SessionContext | null,
) {
  await sessionClient.session.delete({
    ...sessionSdkOptions(context),
    path: { id: sessionID },
  });
}

async function loadSessionMessages(
  sessionClient: any,
  sessionID: string,
  context?: SessionContext | null,
): Promise<Array<any>> {
  const result = await sessionClient.session.messages({
    ...sessionSdkOptions(context),
    path: { id: sessionID },
  });
  return result.data ?? [];
}

async function waitForPromptRecording(
  sessionClient: any,
  sessionID: string,
  prompt: string,
  initialCount: number,
  context?: SessionContext | null,
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const messages = await loadSessionMessages(sessionClient, sessionID, context);
    if (
      messages.length > initialCount &&
      messages
        .slice(initialCount)
        .some((message) => message.info?.role === "user" && flattenText(message.parts ?? []) === prompt)
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(
    "prompt injection did not record a new user message; refusing to report success",
  );
}

async function queuePrompt(
  sessionClient: any,
  sessionID: string,
  prompt: string,
  args: KV,
  context?: SessionContext | null,
): Promise<void> {
  const initialMessages = await loadSessionMessages(sessionClient, sessionID, context);
  await promptAsyncRequest(
    sessionID,
    {
      agent: getString(args, "agent") || undefined,
      model: parseModel(getString(args, "model")),
      parts: [{ type: "text", text: prompt }],
    },
    context,
  );
  await waitForPromptRecording(
    sessionClient,
    sessionID,
    prompt,
    initialMessages.length,
    context,
  );
}

function printSessionHandle(
  sessionID: string,
  context: SessionContext | null,
  json = false,
) {
  if (json) {
    console.log(
      JSON.stringify(
        {
          sessionID,
          directory: context?.directory ?? null,
          workspaceID: context?.workspaceID ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(sessionID);
}

async function writeTranscriptOutput(
  sessionID: string,
  args: KV,
): Promise<void> {
  const outputPath = getString(args, "output");
  const teeTemp = hasFlag(args, "tee-temp");
  if (outputPath && teeTemp) {
    throw new Error("transcript accepts either --output <path> or --tee-temp, not both.");
  }

  const savePath = outputPath
    ? resolve(outputPath)
    : teeTemp
      ? join(
          tmpdir(),
          `opx-transcript-${basename(sessionID)}-${Date.now()}.${hasFlag(args, "json") ? "json" : "md"}`,
        )
      : undefined;

  const transcript = await renderSessionTranscript(sessionID, {
    json: hasFlag(args, "json"),
    savedCopyPath: savePath,
  });

  if (savePath) {
    await Bun.write(savePath, transcript);
  }

  if (!outputPath || teeTemp) {
    process.stdout.write(transcript);
    return;
  }

  console.log(savePath);
}

// ---------------------------------------------------------------------------
// opx public workflow commands
// ---------------------------------------------------------------------------

async function cmdRun(client: any, args: KV): Promise<void> {
  const prompt = getString(args, "prompt");
  if (!prompt) throw new Error("run requires --prompt");

  const lingerSec = Number(getString(args, "linger", "0"));
  const timeoutSec = Number(getString(args, "timeout", "180"));
  const keep = hasFlag(args, "keep");

  const { sessionID, context: sessionContext, sessionClient } =
    await createWorkflowSession(client);
  // Send prompt async and wait via SSE
  await queuePrompt(sessionClient, sessionID, prompt, args, sessionContext);

  const result = await waitForIdle(
    sessionClient,
    sessionID,
    lingerSec,
    timeoutSec,
    sessionContext,
  );

  // Print transcript
  const transcript = await generateTranscript(sessionID);
  process.stdout.write(transcript);

  // Session cleanup — delete unless --keep was explicitly passed
  if (!keep) {
    try {
      await deleteWorkflowSession(sessionClient, sessionID, sessionContext);
    } catch {
      // best-effort
    }
  } else {
    console.error(`[opx] session kept: ${sessionID}`);
  }

  if (result.timedOut) {
    console.error(`[opx] timed out after ${timeoutSec}s`);
  }

  process.exitCode = result.exitCode;
}

async function cmdResume(client: any, args: KV): Promise<void> {
  const sessionID = getString(args, "session");
  const prompt = getString(args, "prompt");
  if (!sessionID) throw new Error("resume requires --session");
  if (!prompt) throw new Error("resume requires --prompt");

  const model = parseModel(getString(args, "model"));
  const agent = getString(args, "agent") || undefined;
  const lingerSec = Number(getString(args, "linger", "0"));
  const timeoutSec = Number(getString(args, "timeout", "180"));
  const keep = hasFlag(args, "keep");
  const { client: sessionClient, context: sessionContext } =
    await makeSessionClient(sessionID);

  await queuePrompt(
    sessionClient,
    sessionID,
    prompt,
    {
      ...args,
      agent: agent || false,
      model: model ? `${model.providerID}/${model.modelID}` : false,
    },
    sessionContext,
  );

  const result = await waitForIdle(
    sessionClient,
    sessionID,
    lingerSec,
    timeoutSec,
    sessionContext,
  );

  const transcript = await generateTranscript(sessionID);
  process.stdout.write(transcript);

  // Session cleanup — delete unless --keep was explicitly passed
  if (!keep) {
    try {
      await deleteWorkflowSession(sessionClient, sessionID, sessionContext);
    } catch {
      // best-effort
    }
  } else {
    console.error(`[opx] session kept: ${sessionID}`);
  }

  if (result.timedOut) {
    console.error(`[opx] timed out after ${timeoutSec}s`);
  }

  process.exitCode = result.exitCode;
}

async function cmdStart(client: any, args: KV): Promise<void> {
  const title = getString(args, "title");
  const { sessionID, context } = await createWorkflowSession(client, title);
  printSessionHandle(sessionID, context, hasFlag(args, "json"));
}

async function cmdPrompt(client: any, args: KV): Promise<void> {
  const sessionID = getString(args, "session");
  const prompt = getString(args, "prompt");
  if (!sessionID) throw new Error("prompt requires --session");
  if (!prompt) throw new Error("prompt requires --prompt");

  const { client: sessionClient, context: sessionContext } =
    await makeSessionClient(sessionID);
  await queuePrompt(sessionClient, sessionID, prompt, args, sessionContext);

  if (hasFlag(args, "wait")) {
    const lingerSec = Number(getString(args, "linger", "0"));
    const timeoutSec = Number(getString(args, "timeout", "180"));
    const result = await waitForIdle(
      sessionClient,
      sessionID,
      lingerSec,
      timeoutSec,
      sessionContext,
    );
    const transcript = await generateTranscript(sessionID);
    process.stdout.write(transcript);
    if (result.timedOut) {
      console.error(`[opx] timed out after ${timeoutSec}s`);
    }
    process.exitCode = result.exitCode;
    return;
  }

  printSessionHandle(sessionID, sessionContext, hasFlag(args, "json"));
}

async function cmdWait(client: any, args: KV): Promise<void> {
  const sessionID = getString(args, "session");
  if (!sessionID) throw new Error("wait requires --session");

  const lingerSec = Number(getString(args, "linger", "0"));
  const timeoutSec = Number(getString(args, "timeout", "180"));
  const { client: sessionClient, context: sessionContext } =
    await makeSessionClient(sessionID);
  const result = await waitForIdle(
    sessionClient,
    sessionID,
    lingerSec,
    timeoutSec,
    sessionContext,
  );
  if (hasFlag(args, "json")) {
    console.log(JSON.stringify({ sessionID, ...result }, null, 2));
  } else {
    console.log(sessionID);
  }
  if (result.timedOut) {
    console.error(`[opx] timed out after ${timeoutSec}s`);
  }
  process.exitCode = result.exitCode;
}

async function cmdMessages(client: any, args: KV): Promise<void> {
  const sessionID = getString(args, "session");
  if (!sessionID) throw new Error("messages requires --session");
  const { client: sessionClient, context: sessionContext } =
    await makeSessionClient(sessionID);
  const messages = await loadSessionMessages(sessionClient, sessionID, sessionContext);
  console.log(JSON.stringify(messages, null, 2));
}

async function cmdTranscript(client: any, args: KV): Promise<void> {
  const sessionID = getString(args, "session");
  if (!sessionID) throw new Error("transcript requires --session");
  await writeTranscriptOutput(sessionID, args);
}

async function cmdDelete(client: any, args: KV): Promise<void> {
  const sessionID = getString(args, "session");
  if (!sessionID) throw new Error("delete requires --session");
  const { client: sessionClient, context: sessionContext } =
    await makeSessionClient(sessionID);
  await deleteWorkflowSession(sessionClient, sessionID, sessionContext);
  console.log(sessionID);
}

// ---------------------------------------------------------------------------
// opx session <subcommand>
// ---------------------------------------------------------------------------

async function cmdSessionDelete(client: any, args: KV) {
  const session = getString(args, "session");
  if (!session) throw new Error("session delete requires --session");
  const { client: sessionClient, context: sessionContext } =
    await makeSessionClient(session);
  await sessionClient.session.delete({
    ...sessionSdkOptions(sessionContext),
    path: { id: session },
  });
  console.log(session);
}

async function cmdSessionMessages(client: any, args: KV) {
  const session = getString(args, "session");
  if (!session) throw new Error("session messages requires --session");
  const { client: sessionClient, context: sessionContext } =
    await makeSessionClient(session);
  const result = await sessionClient.session.messages({
    ...sessionSdkOptions(sessionContext),
    path: { id: session },
  });
  console.log(JSON.stringify(result.data ?? [], null, 2));
}

// ---------------------------------------------------------------------------
// opx provider <subcommand>
// ---------------------------------------------------------------------------

async function cmdProviderList(client: any) {
  // List sessions to get models in use — provider list isn't a first-class API
  // so we collect unique providerIDs from active sessions as a proxy
  const sessions = await client.session.list({});
  const providers = new Set<string>();
  for (const s of sessions.data ?? []) {
    if (s.providerID) providers.add(s.providerID);
  }
  if (providers.size === 0) {
    console.log("(no sessions with provider info — send a prompt first)");
  } else {
    for (const p of providers) console.log(p);
  }
}

async function cmdProviderHealth(client: any, args: KV) {
  const provider = getString(args, "provider");
  // Health check via a quick session probe with a known model for the provider
  const model = getString(args, "model") || `${provider}/claude-sonnet-4.6`;
  const parsed = parseModel(model);
  if (!parsed) throw new Error("Invalid model format — use provider/model");

  const creationContext = currentSessionContext();
  const created = await client.session.create({
    ...sessionSdkOptions(creationContext),
    body: { title: `opx-provider-health:${provider}:${Date.now()}` },
  });
  const sessionID = created.data?.id;
  if (!sessionID) throw new Error("Failed to create probe session");
  const sessionContext =
    sessionContextFromSession(created.data) ??
    (await fetchSessionContext(sessionID));
  const sessionClient = makeClient();

  await promptAsyncRequest(sessionID, {
    agent: "Minimal",
    model: parsed,
    parts: [{ type: "text", text: "Reply with ONLY: OK" }],
  }, sessionContext);

  const result = await waitForIdle(sessionClient, sessionID, 0, 60, sessionContext);

  try {
    await sessionClient.session.delete({
      ...sessionSdkOptions(sessionContext),
      path: { id: sessionID },
    });
  } catch {
    /* best-effort */
  }

  const ok = result.exitCode === 0;
  console.log(
    JSON.stringify(
      {
        provider,
        model,
        ok,
        exitCode: result.exitCode,
        errorKind: result.errorKind,
      },
      null,
      2,
    ),
  );
  process.exitCode = result.exitCode;
}

// ---------------------------------------------------------------------------
// Error inspection helpers (used by debug subcommands)
// ---------------------------------------------------------------------------

async function cmdErrors(client: any, args: KV) {
  const session = getString(args, "session");
  if (!session) throw new Error("errors requires --session");
  const { client: sessionClient, context: sessionContext } =
    await makeSessionClient(session);
  const result = await sessionClient.session.messages({
    ...sessionSdkOptions(sessionContext),
    path: { id: session },
  });
  const rows = (result.data ?? [])
    .filter((m: any) => m.info?.role === "assistant" && m.info?.error)
    .map((m: any) => ({
      messageID: m.info?.id,
      created: m.info?.time?.created,
      completed: m.info?.time?.completed,
      providerID: m.info?.providerID,
      modelID: m.info?.modelID,
      mode: m.info?.mode,
      agent: m.info?.agent,
      errorName: m.info?.error?.name,
      errorData: m.info?.error?.data,
      text: flattenText(m.parts ?? []),
    }));

  console.log(JSON.stringify(rows, null, 2));
}

async function cmdLimitErrors(client: any, args: KV) {
  const session = getString(args, "session");
  if (!session) throw new Error("limit-errors requires --session");
  const verbose = hasFlag(args, "verbose");
  const { client: sessionClient, context: sessionContext } =
    await makeSessionClient(session);
  const result = await sessionClient.session.messages({
    ...sessionSdkOptions(sessionContext),
    path: { id: session },
  });
  const all = (result.data ?? [])
    .filter((m: any) => m.info?.role === "assistant" && m.info?.error)
    .map((m: any) => ({
      sessionID: session,
      messageID: m.info?.id,
      created: m.info?.time?.created,
      providerID: m.info?.providerID,
      modelID: m.info?.modelID,
      agent: m.info?.agent,
      kind: classifyError(m.info?.error),
      summary: summarizeError(m.info?.error?.data ?? m.info?.error),
      error: m.info?.error,
    }));

  const filtered = all.filter((x: any) => x.kind !== "aborted");
  const out = (filtered.length ? filtered : all).map((x: any) =>
    verbose
      ? x
      : {
          sessionID: x.sessionID,
          messageID: x.messageID,
          providerID: x.providerID,
          modelID: x.modelID,
          kind: x.kind,
          summary: x.summary,
        },
  );
  console.log(JSON.stringify(out, null, 2));
}

// ---------------------------------------------------------------------------
// Debug / probe commands
// ---------------------------------------------------------------------------

async function cmdProbeLimit(client: any, args: KV) {
  const modelStr = getString(args, "model");
  if (!modelStr) throw new Error("probe-limit requires --model provider/model");
  const model = parseModel(modelStr);
  if (!model) throw new Error("Invalid --model format");

  const creationContext = currentSessionContext();
  const created = await client.session.create({
    ...sessionSdkOptions(creationContext),
    body: { title: `opx-probe-limit:${modelStr}:${Date.now()}` },
  });
  const sessionID = created.data?.id;
  if (!sessionID) throw new Error("Failed to create probe session");
  const sessionContext =
    sessionContextFromSession(created.data) ??
    (await fetchSessionContext(sessionID));

  await promptAsyncRequest(sessionID, {
    agent: getString(args, "agent", "Minimal"),
    model,
    parts: [
      {
        type: "text",
        text: getString(args, "prompt", "Reply with ONLY OK."),
      },
    ],
  }, sessionContext);

  console.log(sessionID);
}

async function cmdProbeLimitKnown(args: KV) {
  const providerKey = getString(args, "provider");
  if (!providerKey) {
    throw new Error(
      "probe-limit-known requires --provider anthropic|opencode-minimax|opencode-big-pickle",
    );
  }

  const patterns = await loadKnownLimitPatterns();
  const pattern = patterns[providerKey];
  if (!pattern) {
    throw new Error(
      `Unknown provider key '${providerKey}'. Expected one of: ${Object.keys(patterns).join(", ")}`,
    );
  }

  const timeoutSec = Number(getString(args, "timeout", "60"));
  const prompt = getString(args, "prompt", "Reply with ONLY OK.");
  const model = `${pattern.providerID}/${pattern.modelID}`;
  const raw = await runOneShotWithLogs(model, prompt, timeoutSec);
  const match = extractKnownLimitEvent(raw, pattern);

  if (!match) {
    const hintLines = raw
      .split("\n")
      .filter((line) => {
        const s = line.toLowerCase();
        return (
          s.includes(`providerid=${pattern.providerID.toLowerCase()}`) ||
          s.includes(`modelid=${pattern.modelID.toLowerCase()}`) ||
          s.includes("service=session.processor")
        );
      })
      .slice(-12);

    console.log(
      JSON.stringify(
        {
          ok: false,
          available: false,
          code: "KNOWN_PATTERN_NOT_FOUND",
          providerKey,
          providerID: pattern.providerID,
          modelID: pattern.modelID,
          expectedPattern: pattern.match_regex,
          tail: hintLines,
        },
        null,
        2,
      ),
    );
    process.exitCode = 2;
    return;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        available: false,
        providerKey,
        providerID: pattern.providerID,
        modelID: pattern.modelID,
        kind: pattern.normalized_kind,
        matched: match.matchedLine,
        evidence: match.evidence,
      },
      null,
      2,
    ),
  );
  process.exitCode = 2;
}

async function cmdProbeLimitTrace(client: any, args: KV) {
  const modelStr = getString(args, "model");
  if (!modelStr)
    throw new Error("probe-limit-trace requires --model provider/model");
  const model = parseModel(modelStr);
  if (!model) throw new Error("Invalid --model format");

  const timeoutSec = Number(getString(args, "timeout", "60"));
  const verbose = hasFlag(args, "verbose");
  const includeAborted = hasFlag(args, "include-aborted");

  const creationContext = currentSessionContext();
  const created = await client.session.create({
    ...sessionSdkOptions(creationContext),
    body: { title: `opx-probe-limit-trace:${modelStr}:${Date.now()}` },
  });
  const sessionID = created.data?.id;
  if (!sessionID) throw new Error("Failed to create probe session");
  const sessionContext =
    sessionContextFromSession(created.data) ??
    (await fetchSessionContext(sessionID));
  const sessionClient = makeClient();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  const stream = await sessionClient.event.subscribe({
    signal: controller.signal,
    ...sessionSdkOptions(sessionContext),
  });

  const rows: any[] = [];
  const collector = (async () => {
    try {
      for await (const evt of stream.stream as AsyncGenerator<any>) {
        if (!evt || typeof evt !== "object") continue;

        if (evt.type === "message.updated") {
          const info = evt.properties?.info;
          if (
            !info ||
            info.sessionID !== sessionID ||
            info.role !== "assistant"
          )
            continue;
          if (info.error)
            rows.push(normalizeErrorRecord("message.updated", sessionID, info));
          continue;
        }

        if (evt.type === "session.error") {
          const sid = evt.properties?.sessionID;
          if (sid !== sessionID) continue;
          rows.push(
            normalizeErrorRecord("session.error", sessionID, {
              error: evt.properties?.error,
            }),
          );
        }
      }
    } catch {
      // timeout/abort closes stream
    }
  })();

  await promptAsyncRequest(sessionID, {
    agent: getString(args, "agent", "Minimal"),
    model,
    parts: [
      {
        type: "text",
        text: getString(args, "prompt", "Reply with ONLY OK."),
      },
    ],
  }, sessionContext);

  await collector;
  clearTimeout(timer);

  const filtered = includeAborted
    ? rows
    : rows.filter((r) => r.kind !== "aborted");
  const outputRows = (filtered.length ? filtered : rows).map((r) =>
    verbose
      ? r
      : {
          source: r.source,
          sessionID: r.sessionID,
          providerID: r.providerID,
          modelID: r.modelID,
          kind: r.kind,
          summary: r.summary,
        },
  );

  console.log(
    JSON.stringify(
      {
        sessionID,
        model: modelStr,
        timeoutSec,
        matched: outputRows.length,
        rows: outputRows,
      },
      null,
      2,
    ),
  );
}

async function cmdTrace(client: any, args: KV) {
  const session = getString(args, "session");
  if (!session) throw new Error("trace requires --session");
  const timeoutSec = Number(getString(args, "timeout", "60"));
  const verbose = hasFlag(args, "verbose");
  const includeAborted = hasFlag(args, "include-aborted");
  const withServiceLog = !hasFlag(args, "no-service-log");
  const { client: sessionClient, context: sessionContext } =
    await makeSessionClient(session);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);

  const stream = await sessionClient.event.subscribe({
    signal: controller.signal,
    ...sessionSdkOptions(sessionContext),
  });

  const rows: any[] = [];
  const existing = await sessionClient.session.messages({
    ...sessionSdkOptions(sessionContext),
    path: { id: session },
  });
  for (const msg of existing.data ?? []) {
    if (msg.info?.role !== "assistant" || !msg.info?.error) continue;
    rows.push(normalizeErrorRecord("message.history", session, msg.info));
  }
  try {
    for await (const evt of stream.stream as AsyncGenerator<any>) {
      if (!evt || typeof evt !== "object") continue;

      if (evt.type === "message.updated") {
        const info = evt.properties?.info;
        if (!info || info.sessionID !== session || info.role !== "assistant")
          continue;
        if (!info.error) continue;
        rows.push(normalizeErrorRecord("message.updated", session, info));
        continue;
      }

      if (evt.type === "session.error") {
        const sid = evt.properties?.sessionID;
        if (sid !== session) continue;
        rows.push(
          normalizeErrorRecord("session.error", session, {
            error: evt.properties?.error,
          }),
        );
      }
    }
  } catch {
    // timeout/abort closes stream
  } finally {
    clearTimeout(timer);
  }

  const filtered = includeAborted
    ? rows
    : rows.filter((r) => r.kind !== "aborted");
  let outputRows = (filtered.length ? filtered : rows).map((r) =>
    verbose
      ? r
      : {
          source: r.source,
          sessionID: r.sessionID,
          providerID: r.providerID,
          modelID: r.modelID,
          kind: r.kind,
          summary: r.summary,
        },
  );

  if (withServiceLog) {
    const logLines = await readServiceLogLines(
      session,
      Math.max(timeoutSec + 30, 60),
    );
    const logRows = logLines.map((line) => {
      const kind = classifyError(line);
      return verbose
        ? { source: "service.log", sessionID: session, kind, line }
        : {
            source: "service.log",
            sessionID: session,
            kind,
            summary: line.length > 280 ? `${line.slice(0, 280)}...` : line,
          };
    });
    outputRows = [...outputRows, ...logRows];
  }

  console.log(
    JSON.stringify(
      {
        sessionID: session,
        timeoutSec,
        matched: outputRows.length,
        rows: outputRows,
      },
      null,
      2,
    ),
  );
}

async function cmdProbeAsyncCommand(client: any, args: KV) {
  const modelStr = getString(args, "model", "opencode/big-pickle");
  const model = parseModel(modelStr);
  if (!model) throw new Error("Invalid --model format");

  const creationContext = currentSessionContext();
  const created = await client.session.create({
    ...sessionSdkOptions(creationContext),
    body: { title: `opx-probe-async-command:${Date.now()}` },
  });
  const sessionID = created.data?.id;
  if (!sessionID) throw new Error("Failed to create probe session");
  const sessionContext =
    sessionContextFromSession(created.data) ??
    (await fetchSessionContext(sessionID));
  const sessionClient = makeClient();

  await sessionClient.session.prompt({
    ...sessionSdkOptions(sessionContext),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    path: { id: sessionID },
    body: {
      agent: getString(args, "agent", "Minimal"),
      model,
      parts: [
        {
          type: "text",
          text: [
            "Call async_command with seconds=4 and message=PROBE_PING.",
            "When callback arrives, reply with EXACTLY: PROBE_CALLBACK_CONTINUED.",
          ].join(" "),
        },
      ],
    },
  });

  const start = Date.now();
  while (Date.now() - start < 180000) {
    const messages = await sessionClient.session.messages({
      ...sessionSdkOptions(sessionContext),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      path: { id: sessionID },
    });
    const tx = renderAssistantText(messages.data ?? []);
    if (tx.includes("PROBE_CALLBACK_CONTINUED")) {
      console.log(JSON.stringify({ ok: true, sessionID }, null, 2));
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log(
    JSON.stringify({ ok: false, sessionID, reason: "timeout" }, null, 2),
  );
}

async function cmdProbeAsyncSubagent(client: any, args: KV) {
  const modelStr = getString(args, "model", "opencode/big-pickle");
  const model = parseModel(modelStr);
  if (!model) throw new Error("Invalid --model format");

  const creationContext = currentSessionContext();
  const created = await client.session.create({
    ...sessionSdkOptions(creationContext),
    body: { title: `opx-probe-async-subagent:${Date.now()}` },
  });
  const sessionID = created.data?.id;
  if (!sessionID) throw new Error("Failed to create probe session");
  const sessionContext =
    sessionContextFromSession(created.data) ??
    (await fetchSessionContext(sessionID));
  const sessionClient = makeClient();

  await sessionClient.session.prompt({
    ...sessionSdkOptions(sessionContext),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    path: { id: sessionID },
    body: {
      agent: getString(args, "agent", "Minimal"),
      model,
      parts: [
        {
          type: "text",
          text: [
            "Call async_subagent with agent Minimal, model opencode/big-pickle, and prompt: Reply with only READY.",
            "When callback arrives, reply with EXACTLY: PROBE_SUBAGENT_CONTINUED.",
          ].join(" "),
        },
      ],
    },
  });

  const start = Date.now();
  while (Date.now() - start < 180000) {
    const messages = await sessionClient.session.messages({
      ...sessionSdkOptions(sessionContext),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      path: { id: sessionID },
    });
    const tx = renderAssistantText(messages.data ?? []);
    if (tx.includes("PROBE_SUBAGENT_CONTINUED")) {
      console.log(JSON.stringify({ ok: true, sessionID }, null, 2));
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log(
    JSON.stringify({ ok: false, sessionID, reason: "timeout" }, null, 2),
  );
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function help() {
  const text = [
    "opx — OpenCode automation harness",
    "",
    "WORKFLOW COMMANDS:",
    "  run   --prompt <text> [--model provider/model] [--agent <name>] [--linger <sec>] [--keep] [--timeout <sec>]",
    "  start [--title <text>] [--json]",
    "  prompt --session <id> --prompt <text> [--agent <name>] [--model provider/model] [--wait] [--linger <sec>] [--timeout <sec>] [--json]",
    "  wait --session <id> [--linger <sec>] [--timeout <sec>] [--json]",
    "  messages --session <id>",
    "  transcript --session <id> [--json] [--output PATH | --tee-temp]",
    "  delete --session <id>",
    "  resume --session <id> --prompt <text> [--model provider/model] [--agent <name>] [--linger <sec>] [--keep] [--timeout <sec>]",
    "",
    "ADVANCED COMMANDS:",
    "  provider list",
    "  provider health --provider <id> [--model provider/model]",
    "  debug trace --session <id> [--timeout <sec>] [--verbose] [--include-aborted] [--no-service-log]",
    "  debug errors --session <id>",
    "  debug limit-errors --session <id> [--verbose]",
    "  debug probe-limit --model provider/model [--agent <name>] [--prompt <text>]",
    "  debug probe-limit-known --provider anthropic|opencode-minimax|opencode-big-pickle [--timeout <sec>]",
    "  debug probe-limit-trace --model provider/model [--agent <name>] [--timeout <sec>] [--verbose] [--include-aborted]",
    "  debug probe-async-command [--model provider/model] [--agent <name>]",
    "  debug probe-async-subagent [--model provider/model] [--agent <name>]",
    "",
    "Run any command with --help for detailed usage.",
    "Internal surfaces stay behind explicit subcommands such as `opx session --help`.",
    "",
    "EXIT CODES:",
    "  0 = success",
    "  1 = failure (error or timeout)",
    "  2 = provider unavailable (rate limit / quota)",
    "",
    "ENV:",
    "  OPENCODE_BASE_URL (default http://127.0.0.1:4096)",
    "  OPENCODE_SERVER_USERNAME (default opencode)",
    "  OPENCODE_SERVER_PASSWORD (optional)",
    "  Transcript renderer: opx-session transcript <session-id>",
  ];
  console.log(text.join("\n"));
}

function helpRun() {
  console.log(
    [
      "opx run — create a session, send a prompt, wait for idle, print transcript, delete session",
      "",
      "USAGE:",
      "  opx run --prompt <text> [options]",
      "",
      "OPTIONS:",
      "  --prompt <text>          (required) The prompt to send",
      "  --model provider/model   Provider and model slug (e.g. github-copilot/claude-sonnet-4.6)",
      "  --agent <name>           Agent name (e.g. Minimal). Defaults to server default.",
      "  --linger <sec>           Wait N extra seconds after first idle before declaring done. Default: 0.",
      "                           Use this when the agent may spawn async tools that start a second turn.",
      "  --keep                   Do NOT delete the session after completion. Prints session ID to stderr.",
      "  --timeout <sec>          Hard wall-clock timeout. Default: 180.",
      "",
      "OUTPUT:",
      "  stdout: full session transcript (always)",
      "  stderr: [opx] status lines (session kept, timeout warnings)",
      "",
      "EXIT CODES:",
      "  0  success (agent completed without error)",
      "  1  failure (agent error, or hard timeout)",
      "  2  provider unavailable (rate limit / quota exhausted)",
    ].join("\n"),
  );
}

function helpStart() {
  console.log(
    [
      "opx start — create a workflow session and print its session ID",
      "",
      "USAGE:",
      "  opx start [--title <text>] [--json]",
      "",
      "OPTIONS:",
      "  --title <text>   Optional session title",
      "  --json           Emit { sessionID, directory, workspaceID }",
    ].join("\n"),
  );
}

function helpPrompt() {
  console.log(
    [
      "opx prompt — inject a prompt into an existing workflow session",
      "",
      "USAGE:",
      "  opx prompt --session <id> --prompt <text> [options]",
      "",
      "OPTIONS:",
      "  --session <id>           (required) Session ID to target",
      "  --prompt <text>          (required) Prompt text to inject",
      "  --agent <name>           Explicit agent override",
      "  --model provider/model   Explicit model override",
      "  --wait                   Wait for idle and print transcript after injection",
      "  --linger <sec>           Extra idle wait when --wait is used. Default: 0.",
      "  --timeout <sec>          Hard wait timeout when --wait is used. Default: 180.",
      "  --json                   Emit { sessionID, directory, workspaceID } when not waiting",
      "",
      "CONTRACT:",
      "  Success means the prompt was recorded as a new user message.",
      "  If recording cannot be verified, the command fails instead of silently succeeding.",
    ].join("\n"),
  );
}

function helpWait() {
  console.log(
    [
      "opx wait — wait for the next idle boundary on a session",
      "",
      "USAGE:",
      "  opx wait --session <id> [--linger <sec>] [--timeout <sec>] [--json]",
    ].join("\n"),
  );
}

function helpMessages() {
  console.log(
    [
      "opx messages — dump session messages as JSON",
      "",
      "USAGE:",
      "  opx messages --session <id>",
    ].join("\n"),
  );
}

function helpTranscript() {
  console.log(
    [
      "opx transcript — render a session transcript from the live server",
      "",
      "USAGE:",
      "  opx transcript --session <id> [--json] [--output PATH | --tee-temp]",
    ].join("\n"),
  );
}

function helpDelete() {
  console.log(
    [
      "opx delete — delete a workflow session",
      "",
      "USAGE:",
      "  opx delete --session <id>",
    ].join("\n"),
  );
}

function helpResume() {
  console.log(
    [
      "opx resume — send a follow-up prompt to an existing session, wait for idle, print transcript",
      "",
      "USAGE:",
      "  opx resume --session <id> --prompt <text> [options]",
      "",
      "OPTIONS:",
      "  --session <id>           (required) Session ID to resume",
      "  --prompt <text>          (required) Follow-up prompt to send",
      "  --model provider/model   Override model for this turn",
      "  --agent <name>           Override agent for this turn",
      "  --linger <sec>           Extra idle wait. Default: 0.",
      "  --keep                   Do NOT delete the session after completion.",
      "  --timeout <sec>          Hard wall-clock timeout. Default: 180.",
      "",
      "OUTPUT:",
      "  stdout: full session transcript (always)",
      "  stderr: [opx] status lines",
      "",
      "EXIT CODES: same as opx run",
    ].join("\n"),
  );
}

function helpSession() {
  console.log(
    [
      "opx session — internal session subcommands",
      "",
      "SUBCOMMANDS:",
      "  session delete   --session <id>   Delete a specific session",
      "  session messages --session <id>   Dump all messages as JSON",
      "",
      "This surface is internal and intentionally omitted from the primary workflow help.",
      "Use the top-level workflow commands unless you are debugging CLI internals.",
    ].join("\n"),
  );
}

function helpProvider() {
  console.log(
    [
      "opx provider — inspect provider availability",
      "",
      "SUBCOMMANDS:",
      "  provider list",
      "    List providers seen in recent sessions (proxy — send a prompt first if empty).",
      "",
      "  provider health --provider <id> [--model provider/model]",
      "    Fire a minimal probe prompt and report ok/fail + error kind.",
      "    --provider <id>          e.g. github-copilot, anthropic",
      "    --model provider/model   Optional override. Default: <provider>/claude-sonnet-4.6",
      "",
      "OUTPUT: JSON  { provider, model, ok, exitCode, errorKind }",
      "EXIT CODES: 0 = reachable, 1 = error, 2 = rate-limited / quota",
    ].join("\n"),
  );
}

function helpDebug() {
  console.log(
    [
      "opx debug — low-level inspection and provider probing",
      "",
      "SUBCOMMANDS:",
      "",
      "  trace --session <id> [--timeout <sec>] [--verbose] [--include-aborted] [--no-service-log]",
      "    Stream session events interleaved with systemd service log lines.",
      "    Useful for post-mortem on a --keep session.",
      "",
      "  errors --session <id>",
      "    Dump all assistant error events as JSON.",
      "",
      "  limit-errors --session <id> [--verbose]",
      "    Dump rate-limit / quota error events, classified and summarized.",
      "    --verbose  include full error object",
      "",
      "  probe-limit --model provider/model [--agent <name>] [--prompt <text>]",
      "    Send a prompt designed to trigger a rate-limit response. Reports error classification.",
      "",
      "  probe-limit-known --provider anthropic|opencode-minimax|opencode-big-pickle [--timeout <sec>]",
      "    Strict deterministic probe: matches against known_limit_patterns.json.",
      "    Fails with KNOWN_PATTERN_NOT_FOUND if provider phrasing has changed.",
      "",
      "  probe-limit-trace --model provider/model [--agent <name>] [--timeout <sec>] [--verbose] [--include-aborted]",
      "    probe-limit + full event trace in one command.",
      "",
      "  probe-async-command [--model provider/model] [--agent <name>]",
      "    Verify the async_command plugin tool is reachable and returns a result.",
      "",
      "  probe-async-subagent [--model provider/model] [--agent <name>]",
      "    Verify the async_subagent plugin tool is reachable and returns a result.",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

async function main() {
  const { command, subcommand, args } = parseArgs(process.argv.slice(2));
  const client = makeClient();

  switch (command) {
    // Primary public API
    case "run":
      if (hasFlag(args, "help")) {
        helpRun();
        break;
      }
      await cmdRun(client, args);
      break;
    case "start":
      if (hasFlag(args, "help")) {
        helpStart();
        break;
      }
      await cmdStart(client, args);
      break;
    case "prompt":
      if (hasFlag(args, "help")) {
        helpPrompt();
        break;
      }
      await cmdPrompt(client, args);
      break;
    case "wait":
      if (hasFlag(args, "help")) {
        helpWait();
        break;
      }
      await cmdWait(client, args);
      break;
    case "messages":
      if (hasFlag(args, "help")) {
        helpMessages();
        break;
      }
      await cmdMessages(client, args);
      break;
    case "transcript":
      if (hasFlag(args, "help")) {
        helpTranscript();
        break;
      }
      await cmdTranscript(client, args);
      break;
    case "delete":
      if (hasFlag(args, "help")) {
        helpDelete();
        break;
      }
      await cmdDelete(client, args);
      break;
    case "resume":
      if (hasFlag(args, "help")) {
        helpResume();
        break;
      }
      await cmdResume(client, args);
      break;

    // session subcommands
    case "session":
      if (hasFlag(args, "help") || !subcommand) {
        helpSession();
        break;
      }
      switch (subcommand) {
        case "delete":
          await cmdSessionDelete(client, args);
          break;
        case "messages":
          await cmdSessionMessages(client, args);
          break;
        default:
          console.error(`Unknown session subcommand: ${subcommand}`);
          helpSession();
          process.exitCode = 1;
      }
      break;

    // provider subcommands
    case "provider":
      if (hasFlag(args, "help") || !subcommand) {
        helpProvider();
        break;
      }
      switch (subcommand) {
        case "list":
          await cmdProviderList(client);
          break;
        case "health":
          await cmdProviderHealth(client, args);
          break;
        default:
          console.error(`Unknown provider subcommand: ${subcommand}`);
          helpProvider();
          process.exitCode = 1;
      }
      break;

    // debug subcommands
    case "debug":
      if (hasFlag(args, "help") || !subcommand) {
        helpDebug();
        break;
      }
      switch (subcommand) {
        case "trace":
          await cmdTrace(client, args);
          break;
        case "errors":
          await cmdErrors(client, args);
          break;
        case "limit-errors":
          await cmdLimitErrors(client, args);
          break;
        case "probe-limit":
          await cmdProbeLimit(client, args);
          break;
        case "probe-limit-known":
          await cmdProbeLimitKnown(args);
          break;
        case "probe-limit-trace":
          await cmdProbeLimitTrace(client, args);
          break;
        case "probe-async-command":
          await cmdProbeAsyncCommand(client, args);
          break;
        case "probe-async-subagent":
          await cmdProbeAsyncSubagent(client, args);
          break;
        default:
          console.error(`Unknown debug subcommand: ${subcommand}`);
          helpDebug();
          process.exitCode = 1;
      }
      break;

    default:
      help();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
