#!/usr/bin/env bun
/**
 * Session Management CLI Harness - Full API
 * 
 * Comprehensive session management for OpenCode testing and development.
 * Exposes the complete session API surface.
 * 
 * Usage:
 *   opx-session <command> [options]
 * 
 * Commands:
 *   list, get, children, create, update, delete
 *   abort, share, unshare, summarize
 *   messages, message
 *   prompt, command, shell
 *   revert, unrevert
 *   init, permissions, permission
 *   stats
 */

import { $ } from "bun";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import {
  renderTranscriptJson,
  renderTranscriptMarkdown,
  type TranscriptExport,
} from "./transcript";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const OPENCODE_BASE_URL = process.env.OPENCODE_BASE_URL ?? "http://localhost:4096";
const OPENCODE_API_KEY = process.env.OPENCODE_API_KEY;

const API_BASE = OPENCODE_BASE_URL;

const headers: Record<string, string> = {
  "Content-Type": "application/json",
};

if (OPENCODE_API_KEY) {
  headers["Authorization"] = `Bearer ${OPENCODE_API_KEY}`;
}

// ---------------------------------------------------------------------------
// Types (from OpenCode API)
// ---------------------------------------------------------------------------

interface Session {
  id: string;
  directory?: string;
  workspaceID?: string;
  title: string;
  time: {
    created: number;
    updated: number;
  };
  summary?: {
    additions: number;
    deletions: number;
    files: number;
  };
  parentID?: string;
  shared?: boolean;
  shareUrl?: string;
}

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  providerID?: string;
  modelID?: string;
  time?: {
    created: number;
  };
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: {
      read: number;
      write: number;
    };
  };
}

interface Part {
  type: string;
  text?: string;
  content?: string;
  [key: string]: any;
}

interface AssistantMessage extends Message {
  role: "assistant";
}

interface UserMessage extends Message {
  role: "user";
}

type PromptResult =
  | {
      queued: true;
      noReply: true;
    }
  | {
      info: Message;
      parts: Part[];
    };

type PromptOptions = {
  agent?: string;
  noReply?: boolean;
  outputFormat?: string;
};

interface PermissionRequest {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: {
    messageID: string;
    callID: string;
  };
}

// ---------------------------------------------------------------------------
// API Client
// ---------------------------------------------------------------------------

function encodeDirectoryHeader(directory: string): string {
  return /[^\x00-\x7F]/.test(directory)
    ? encodeURIComponent(directory)
    : directory;
}

function normalizeHeaders(input?: HeadersInit): Record<string, string> {
  if (!input) {
    return {};
  }
  if (input instanceof Headers) {
    return Object.fromEntries(input.entries());
  }
  if (Array.isArray(input)) {
    return Object.fromEntries(input);
  }
  return { ...input };
}

function withBaseHeaders(input?: HeadersInit): Record<string, string> {
  return {
    ...headers,
    ...normalizeHeaders(input),
  };
}

function withSessionContextHeaders(
  input: HeadersInit | undefined,
  session:
    | Pick<Session, "directory" | "workspaceID">
    | null,
): Record<string, string> {
  const next = withBaseHeaders(input);
  if (!session) {
    return next;
  }
  if (session.directory) {
    next["x-opencode-directory"] = encodeDirectoryHeader(session.directory);
  }
  if (session.workspaceID) {
    next["x-opencode-workspace"] = session.workspaceID;
  }
  return next;
}

async function apiRequest<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const url = `${API_BASE}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: withBaseHeaders(options?.headers),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(`API error (${response.status}): ${errorText}`);
  }

  if (response.status === 204) {
    return {} as T;
  }

  return response.json() as Promise<T>;
}

async function sessionRequest<T>(
  sessionID: string,
  endpoint: string,
  options?: RequestInit,
): Promise<T> {
  const session = await getSession(sessionID);
  return apiRequest<T>(endpoint, {
    ...options,
    headers: withSessionContextHeaders(options?.headers, session),
  });
}

async function promptAsyncRequest(
  sessionID: string,
  body: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(
    `${API_BASE}/session/${encodeURIComponent(sessionID)}/prompt_async`,
    {
      method: "POST",
      headers: withSessionContextHeaders(undefined, await getSession(sessionID)),
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(`API error (${response.status}): ${errorText}`);
  }
}

function parseModelRef(model: string | undefined): {
  providerID: string;
  modelID: string;
} {
  const value = (model ?? "").trim();
  const [providerID, ...rest] = value.split("/");
  if (!providerID || rest.length === 0) {
    throw new Error("Expected --model in provider/model format.");
  }
  return {
    providerID,
    modelID: rest.join("/"),
  };
}

function mapPermissionResponse(
  response:
    | "allow"
    | "deny"
    | "allow-session"
    | "deny-session"
    | "once"
    | "always"
    | "reject",
): "once" | "always" | "reject" {
  switch (response) {
    case "allow":
      return "once";
    case "allow-session":
      return "always";
    case "deny":
    case "deny-session":
    case "reject":
      return "reject";
    case "once":
    case "always":
      return response;
  }
}

// ---------------------------------------------------------------------------
// Session Operations - Full API
// ---------------------------------------------------------------------------

// session.list()
async function listSessions(): Promise<Session[]> {
  const data = await apiRequest<Session[]>("/session");
  return (data ?? []).sort((a, b) => b.time.updated - a.time.updated);
}

// session.get({ path: { id } })
async function getSession(sessionID: string): Promise<Session | null> {
  try {
    const data = await apiRequest<Session>(`/session/${sessionID}`);
    return data ?? null;
  } catch (error: any) {
    if (error.message?.includes("404")) {
      return null;
    }
    throw error;
  }
}

// session.children({ path: { id } })
async function getChildSessions(sessionID: string): Promise<Session[]> {
  try {
    const data = await sessionRequest<Session[]>(
      sessionID,
      `/session/${sessionID}/children`,
    );
    return (data ?? []).sort((a, b) => b.time.updated - a.time.updated);
  } catch (error: any) {
    if (error.message?.includes("404")) {
      return [];
    }
    throw error;
  }
}

// session.create({ body })
async function createSession(options?: { title?: string; parentID?: string }): Promise<Session> {
  const parent = options?.parentID ? await getSession(options.parentID) : null;
  const context = parent ?? { directory: process.cwd() };
  const data = await apiRequest<Session>("/session", {
    method: "POST",
    headers: withSessionContextHeaders(undefined, context),
    body: JSON.stringify({
      title: options?.title ?? `session-${Date.now()}`,
      parentID: options?.parentID,
    }),
  });
  
  if (!data) {
    throw new Error("Failed to create session");
  }
  
  return data;
}

// session.update({ path: { id }, body })
async function updateSession(sessionID: string, updates: { title?: string; [key: string]: any }): Promise<Session> {
  const data = await sessionRequest<Session>(sessionID, `/session/${sessionID}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
  
  if (!data) {
    throw new Error("Failed to update session");
  }
  
  return data;
}

// session.delete({ path: { id } })
async function deleteSession(sessionID: string): Promise<boolean> {
  try {
    return await sessionRequest<boolean>(sessionID, `/session/${sessionID}`, {
      method: "DELETE",
    });
  } catch (error: any) {
    if (error.message?.includes("404")) {
      return false;
    }
    throw error;
  }
}

// session.abort({ path: { id } })
async function abortSession(sessionID: string): Promise<boolean> {
  try {
    return await sessionRequest<boolean>(sessionID, `/session/${sessionID}/abort`, {
      method: "POST",
    });
  } catch (error: any) {
    if (error.message?.includes("404")) {
      return false;
    }
    throw error;
  }
}

// session.share({ path: { id } })
async function shareSession(sessionID: string): Promise<Session> {
  const data = await sessionRequest<Session>(sessionID, `/session/${sessionID}/share`, {
    method: "POST",
  });
  
  if (!data) {
    throw new Error("Failed to share session");
  }
  
  return data;
}

// session.unshare({ path: { id } })
async function unshareSession(sessionID: string): Promise<Session> {
  const data = await sessionRequest<Session>(sessionID, `/session/${sessionID}/share`, {
    method: "DELETE",
  });
  
  if (!data) {
    throw new Error("Failed to unshare session");
  }
  
  return data;
}

// session.summarize({ path: { id }, body })
async function summarizeSession(
  sessionID: string,
  options: { model?: string },
): Promise<boolean> {
  try {
    const model = parseModelRef(options.model);
    await sessionRequest<boolean>(sessionID, `/session/${sessionID}/summarize`, {
      method: "POST",
      body: JSON.stringify(model),
    });
    return true;
  } catch (error: any) {
    if (error.message?.includes("404")) {
      return false;
    }
    throw error;
  }
}

// session.messages({ path: { id } })
async function getMessages(sessionID: string): Promise<Array<{ info: Message; parts: Part[] }>> {
  const data = await sessionRequest<Array<{ info: Message; parts: Part[] }>>(
    sessionID,
    `/session/${sessionID}/message`,
  );
  return data ?? [];
}

// session.message({ path: { id, messageId } })
async function getMessage(sessionID: string, messageID: string): Promise<{ info: Message; parts: Part[] } | null> {
  try {
    const data = await sessionRequest<{ info: Message; parts: Part[] }>(
      sessionID,
      `/session/${sessionID}/message/${messageID}`,
    );
    return data ?? null;
  } catch (error: any) {
    if (error.message?.includes("404")) {
      return null;
    }
    throw error;
  }
}

// session.prompt({ path: { id }, body })
function buildPromptRequestBody(message: string, options?: { agent?: string }) {
  return {
    ...(options?.agent ? { agent: options.agent } : {}),
    parts: [{ type: "text", text: message }],
  };
}

async function sendPrompt(
  sessionID: string,
  message: string,
  options?: PromptOptions,
): Promise<PromptResult> {
  if (options?.outputFormat) {
    throw new Error(
      "--output-format is not supported by the current OpenCode session prompt API.",
    );
  }

  if (options?.noReply) {
    await promptAsyncRequest(sessionID, buildPromptRequestBody(message, options));
    return { queued: true, noReply: true };
  }

  const session = await getSession(sessionID);
  const response = await fetch(
    `${API_BASE}/session/${encodeURIComponent(sessionID)}/message`,
    {
      method: "POST",
      headers: withSessionContextHeaders(
        { "Accept": "text/event-stream", "Content-Type": "application/json" },
        session
      ),
      body: JSON.stringify(buildPromptRequestBody(message, options)),
    }
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(`API error (${response.status}): ${errorText}`);
  }

  let finalMessage: { info: Message; parts: Part[] } | null = null;
  let buffer = "";

  const reader =
    response.body != null && typeof (response.body as { getReader?: unknown }).getReader === "function"
      ? (response.body as ReadableStream<Uint8Array>).getReader()
      : null;
  if (reader) {
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      
      for (const line of lines) {
        if (line.startsWith("data:")) {
          const dataStr = line.slice(line.startsWith("data: ") ? 6 : 5).trim();
          if (!dataStr || dataStr === "[DONE]") continue;
          try {
            const evt = JSON.parse(dataStr);
            if (
              evt.type === "message.updated" &&
              evt.properties?.info?.role === "assistant" &&
              evt.properties?.info?.finish !== "tool-calls"
            ) {
              finalMessage = evt.properties;
            }
          } catch (e) {
            // ignore JSON parse errors for incomplete chunks
          }
        }
      }
    }
  } else {
    // Fallback if response.body is not a ReadableStream (e.g. node-fetch in some environments)
    const text = await response.text();
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (line.startsWith("data:")) {
        const dataStr = line.slice(line.startsWith("data: ") ? 6 : 5).trim();
        if (!dataStr || dataStr === "[DONE]") continue;
        try {
          const evt = JSON.parse(dataStr);
          if (
            evt.type === "message.updated" &&
            evt.properties?.info?.role === "assistant" &&
            evt.properties?.info?.finish !== "tool-calls"
          ) {
            finalMessage = evt.properties;
          }
        } catch (e) {}
      }
    }
  }

  // Parse remaining buffer just in case
  if (buffer.trim().startsWith("data:")) {
    try {
      const trimmed = buffer.trim();
      const dataStr = trimmed.slice(trimmed.startsWith("data: ") ? 6 : 5).trim();
      if (dataStr && dataStr !== "[DONE]") {
        const evt = JSON.parse(dataStr);
        if (
          evt.type === "message.updated" &&
          evt.properties?.info?.role === "assistant" &&
          evt.properties?.info?.finish !== "tool-calls"
        ) {
          finalMessage = evt.properties;
        }
      }
    } catch (e) {}
  }

  if (!finalMessage) {
    const messages = await getMessages(sessionID);
    const last = messages[messages.length - 1];
    if (last && last.info.role === "assistant") {
      return last;
    }
    throw new Error("Failed to receive assistant response from stream");
  }

  return finalMessage;
}

// session.command({ path: { id }, body })
async function sendCommand(
  sessionID: string,
  command: string,
  args?: string[]
): Promise<{ info: AssistantMessage; parts: Part[] }> {
  const data = await sessionRequest<{ info: AssistantMessage; parts: Part[] }>(
    sessionID,
    `/session/${sessionID}/command`,
    {
      method: "POST",
      body: JSON.stringify({
        command,
        arguments: (args ?? []).join(" "),
      }),
    },
  );
  
  if (!data) {
    throw new Error("Failed to send command");
  }
  
  return data;
}

// session.shell({ path: { id }, body })
async function runShell(
  sessionID: string,
  command: string,
  options?: { agent?: string }
): Promise<AssistantMessage> {
  const data = await sessionRequest<AssistantMessage>(
    sessionID,
    `/session/${sessionID}/shell`,
    {
      method: "POST",
      body: JSON.stringify({
        agent: options?.agent ?? "Interactive",
        command,
      }),
    },
  );
  
  if (!data) {
    throw new Error("Failed to run shell command");
  }
  
  return data;
}

// session.revert({ path: { id }, body })
async function revertMessage(sessionID: string, messageID: string): Promise<Session> {
  const data = await sessionRequest<Session>(
    sessionID,
    `/session/${sessionID}/revert`,
    {
      method: "POST",
      body: JSON.stringify({ messageID }),
    },
  );
  
  if (!data) {
    throw new Error("Failed to revert message");
  }
  
  return data;
}

// session.unrevert({ path: { id } })
async function unrevertSession(sessionID: string): Promise<Session> {
  const data = await sessionRequest<Session>(
    sessionID,
    `/session/${sessionID}/unrevert`,
    {
      method: "POST",
    },
  );
  
  if (!data) {
    throw new Error("Failed to unrevert session");
  }
  
  return data;
}

// session.init({ path: { id }, body })
async function initSession(
  sessionID: string,
  options: { messageID?: string; model?: string }
): Promise<boolean> {
  try {
    if (!options.messageID) {
      throw new Error("init requires --message-id <message-id>.");
    }
    const model = parseModelRef(options.model);
    await sessionRequest<boolean>(sessionID, `/session/${sessionID}/init`, {
      method: "POST",
      body: JSON.stringify({
        messageID: options.messageID,
        ...model,
      }),
    });
    return true;
  } catch (error: any) {
    if (error.message?.includes("404")) {
      return false;
    }
    throw error;
  }
}

// permission.list()
async function listPermissions(sessionID?: string): Promise<PermissionRequest[]> {
  if (!sessionID) {
    return (await apiRequest<PermissionRequest[]>("/permission")) ?? [];
  }
  const session = await getSession(sessionID);
  return (
    (await apiRequest<PermissionRequest[]>("/permission", {
      headers: withSessionContextHeaders(undefined, session),
    })) ?? []
  );
}

// postSessionByIdPermissionsByPermissionId({ path, body })
async function respondToPermission(
  sessionID: string,
  permissionID: string,
  response:
    | "allow"
    | "deny"
    | "allow-session"
    | "deny-session"
    | "once"
    | "always"
    | "reject"
): Promise<boolean> {
  try {
    const session = await getSession(sessionID);
    return await apiRequest<boolean>(`/permission/${permissionID}/reply`, {
      method: "POST",
      headers: withSessionContextHeaders(undefined, session),
      body: JSON.stringify({ reply: mapPermissionResponse(response) }),
    });
  } catch (error: any) {
    if (error.message?.includes("404")) {
      return false;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

interface SessionStats {
  totalSessions: number;
  totalTurns: number;
  totalTokens: {
    input: number;
    output: number;
    reasoning: number;
  };
  averageTurnsPerSession: number;
  averageTokensPerSession: number;
  oldestSession: Session | null;
  newestSession: Session | null;
}

async function getStats(): Promise<SessionStats> {
  const sessions = await listSessions();
  
  if (sessions.length === 0) {
    return {
      totalSessions: 0,
      totalTurns: 0,
      totalTokens: { input: 0, output: 0, reasoning: 0 },
      averageTurnsPerSession: 0,
      averageTokensPerSession: 0,
      oldestSession: null,
      newestSession: null,
    };
  }
  
  let totalTurns = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalReasoningTokens = 0;
  
  for (const session of sessions) {
    const messages = await getMessages(session.id);
    totalTurns += messages.length;
    
    for (const msg of messages) {
      if (msg.info.role === "assistant" && msg.info.tokens) {
        totalInputTokens += msg.info.tokens.input;
        totalOutputTokens += msg.info.tokens.output;
        totalReasoningTokens += msg.info.tokens.reasoning;
      }
    }
  }
  
  return {
    totalSessions: sessions.length,
    totalTurns,
    totalTokens: {
      input: totalInputTokens,
      output: totalOutputTokens,
      reasoning: totalReasoningTokens,
    },
    averageTurnsPerSession: Math.round(totalTurns / sessions.length),
    averageTokensPerSession: Math.round((totalInputTokens + totalOutputTokens + totalReasoningTokens) / sessions.length),
    oldestSession: sessions[sessions.length - 1] ?? null,
    newestSession: sessions[0] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatTime(epoch: number): string {
  return new Date(epoch).toISOString();
}

function formatDuration(startMs: number, endMs: number): string {
  const diffS = Math.floor((endMs - startMs) / 1000);
  if (diffS < 60) return `${diffS}s`;
  if (diffS < 3600) return `${Math.floor(diffS / 60)}m ${diffS % 60}s`;
  const h = Math.floor(diffS / 3600);
  const m = Math.floor((diffS % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatSession(session: Session, verbose = false): string {
  const lines = [
    `ID: ${session.id}`,
    `  Title:   ${session.title}`,
    `  Created: ${formatTime(session.time.created)}`,
    `  Updated: ${formatTime(session.time.updated)}`,
    `  Duration: ${formatDuration(session.time.created, session.time.updated)}`,
  ];

  if (session.parentID) {
    lines.push(`  Parent:  ${session.parentID}`);
  }

  if (session.summary) {
    lines.push(
      `  Changes: +${session.summary.additions} -${session.summary.deletions} (${session.summary.files} files)`
    );
  }

  if (session.shared) {
    lines.push(`  Shared:  ${session.shareUrl ?? "yes"}`);
  }

  if (verbose) {
    lines.push(`  (use 'messages ${session.id}' to view transcript)`);
  }

  return lines.join("\n");
}

function formatMessage(msg: { info: Message; parts: Part[] }): string {
  const role = msg.info.role.toUpperCase();
  const time = formatTime(msg.info.time?.created ?? Date.now());
  
  let details = "";
  if (msg.info.role === "assistant") {
    const model = msg.info.providerID && msg.info.modelID 
      ? `${msg.info.providerID}/${msg.info.modelID}`
      : "unknown";
    details = ` [${model}]`;
    
    if (msg.info.tokens) {
      const total = msg.info.tokens.input + msg.info.tokens.output + msg.info.tokens.reasoning;
      details += ` ${total.toLocaleString()} tokens`;
    }
  }
  
  return `${role}${details} @ ${time}`;
}

async function loadTranscriptExport(sessionID: string): Promise<TranscriptExport> {
  const session = await getSession(sessionID);
  if (!session) {
    throw new Error(`Session not found: ${sessionID}`);
  }

  return {
    info: session,
    messages: await getMessages(sessionID),
  };
}

async function loadTranscriptExportFile(
  inputPath: string,
): Promise<TranscriptExport> {
  const resolvedPath = resolve(inputPath);
  return JSON.parse(await Bun.file(resolvedPath).text()) as TranscriptExport;
}

async function renderSessionTranscript(
  sessionID: string,
  options?: { json?: boolean; savedCopyPath?: string },
): Promise<string> {
  const exported = await loadTranscriptExport(sessionID);
  if (options?.json) {
    return JSON.stringify(renderTranscriptJson(exported), null, 2);
  }
  return renderTranscriptMarkdown(exported, {
    savedCopyPath: options?.savedCopyPath,
  });
}

async function renderInputTranscript(
  inputPath: string,
  options?: { json?: boolean; savedCopyPath?: string },
): Promise<string> {
  const exported = await loadTranscriptExportFile(inputPath);
  if (options?.json) {
    return JSON.stringify(renderTranscriptJson(exported), null, 2);
  }
  return renderTranscriptMarkdown(exported, {
    savedCopyPath: options?.savedCopyPath,
  });
}

async function cmdTranscript(
  target: { input?: string; sessionID?: string },
  options: { json?: boolean; output?: string; teeTemp?: boolean },
): Promise<void> {
  if (options.output && options.teeTemp) {
    throw new Error("transcript accepts either --output <path> or --tee-temp, not both.");
  }
  if (!!target.sessionID === !!target.input) {
    throw new Error("transcript requires exactly one of <session-id> or --input <path>.");
  }

  const teeLabel = target.sessionID
    ? target.sessionID
    : basename(target.input ?? "transcript.json").replace(/\.[^.]+$/, "");

  const outputPath = options.output
    ? resolve(options.output)
    : options.teeTemp
      ? join(
          tmpdir(),
          `opx-session-${teeLabel}-${Date.now()}.${options.json ? "json" : "md"}`,
        )
      : undefined;

  const transcript = target.sessionID
    ? await renderSessionTranscript(target.sessionID, {
        json: options.json,
        savedCopyPath: outputPath,
      })
    : await renderInputTranscript(target.input ?? "", {
        json: options.json,
        savedCopyPath: outputPath,
      });

  if (outputPath) {
    await Bun.write(outputPath, transcript);
  }

  if (!options.output || options.teeTemp) {
    process.stdout.write(transcript);
    return;
  }

  console.log(outputPath);
}

// ---------------------------------------------------------------------------
// CLI Commands
// ---------------------------------------------------------------------------

async function cmdList(options: { limit?: number; json?: boolean }): Promise<void> {
  const sessions = await listSessions();
  const limited = options.limit ? sessions.slice(0, options.limit) : sessions;
  
  if (options.json) {
    console.log(JSON.stringify(limited, null, 2));
    return;
  }
  
  if (limited.length === 0) {
    console.log("No sessions found.");
    return;
  }
  
  console.log(`Total sessions: ${sessions.length}${options.limit ? ` (showing ${limited.length})` : ""}\n`);
  
  for (const session of limited) {
    console.log(formatSession(session, true));
    console.log();
  }
}

async function cmdGet(sessionID: string, options: { json?: boolean }): Promise<void> {
  const session = await getSession(sessionID);
  
  if (!session) {
    console.error(`Session not found: ${sessionID}`);
    process.exit(1);
  }
  
  if (options.json) {
    console.log(JSON.stringify(session, null, 2));
    return;
  }
  
  console.log(formatSession(session, true));
}

async function cmdChildren(sessionID: string, options: { json?: boolean }): Promise<void> {
  const children = await getChildSessions(sessionID);
  
  if (options.json) {
    console.log(JSON.stringify(children, null, 2));
    return;
  }
  
  if (children.length === 0) {
    console.log(`No child sessions for: ${sessionID}`);
    return;
  }
  
  console.log(`Child sessions of ${sessionID}: ${children.length}\n`);
  
  for (const child of children) {
    console.log(formatSession(child));
    console.log();
  }
}

async function cmdCreate(options: {
  title?: string;
  parent?: string;
  json?: boolean;
}): Promise<void> {
  const session = await createSession({
    title: options.title,
    parentID: options.parent,
  });

  if (options.json) {
    console.log(JSON.stringify(session, null, 2));
    return;
  }

  console.log(`Created session:`);
  console.log(`  ID:    ${session.id}`);
  console.log(`  Title: ${session.title}`);
  if (session.parentID) {
    console.log(`  Parent: ${session.parentID}`);
  }
}

async function cmdUpdate(
  sessionID: string,
  updates: { title?: string; json?: boolean },
): Promise<void> {
  const session = await updateSession(sessionID, updates);

  if (updates.json) {
    console.log(JSON.stringify(session, null, 2));
    return;
  }

  console.log(`Updated session:`);
  console.log(formatSession(session));
}

async function cmdDelete(
  sessionID: string,
  options: { json?: boolean },
): Promise<void> {
  const deleted = await deleteSession(sessionID);

  if (!deleted) {
    console.error(`Session not found: ${sessionID}`);
    process.exit(1);
  }

  if (options.json) {
    console.log(JSON.stringify({ ok: true, sessionID }, null, 2));
    return;
  }

  console.log(`Deleted session: ${sessionID}`);
}

async function cmdAbort(
  sessionID: string,
  options: { json?: boolean },
): Promise<void> {
  const aborted = await abortSession(sessionID);

  if (!aborted) {
    console.error(`Session not found: ${sessionID}`);
    process.exit(1);
  }

  if (options.json) {
    console.log(JSON.stringify({ ok: true, sessionID }, null, 2));
    return;
  }

  console.log(`Aborted session: ${sessionID}`);
}

async function cmdShare(
  sessionID: string,
  options: { json?: boolean },
): Promise<void> {
  const session = await shareSession(sessionID);

  if (options.json) {
    console.log(JSON.stringify(session, null, 2));
    return;
  }

  console.log(`Shared session:`);
  console.log(`  ID:  ${session.id}`);
  console.log(`  URL: ${session.shareUrl ?? "(not available)"}`);
}

async function cmdUnshare(
  sessionID: string,
  options: { json?: boolean },
): Promise<void> {
  const session = await unshareSession(sessionID);

  if (options.json) {
    console.log(JSON.stringify(session, null, 2));
    return;
  }

  console.log(`Unshared session: ${sessionID}`);
}

async function cmdSummarize(
  sessionID: string,
  options: { model?: string; json?: boolean },
): Promise<void> {
  const summarized = await summarizeSession(sessionID, {
    model: options.model,
  });

  if (!summarized) {
    console.error(`Session not found: ${sessionID}`);
    process.exit(1);
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        { ok: true, action: "summarize", sessionID, model: options.model },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`Summarization started for: ${sessionID}`);
}

async function cmdMessages(sessionID: string, options: { limit?: number; json?: boolean }): Promise<void> {
  const session = await getSession(sessionID);
  if (!session) {
    console.error(`Session not found: ${sessionID}`);
    process.exit(1);
  }
  
  const messages = await getMessages(sessionID);
  const limited = options.limit ? messages.slice(0, options.limit) : messages;
  
  if (options.json) {
    console.log(JSON.stringify(limited, null, 2));
    return;
  }
  
  console.log(`Session: ${session.title}`);
  console.log(`Messages: ${messages.length}${options.limit ? ` (showing ${limited.length})` : ""}\n`);
  
  for (const msg of limited) {
    console.log(formatMessage(msg));
  }
}

async function cmdMessage(sessionID: string, messageID: string, options: { json?: boolean }): Promise<void> {
  const msg = await getMessage(sessionID, messageID);
  
  if (!msg) {
    console.error(`Message not found: ${messageID} in session ${sessionID}`);
    process.exit(1);
  }
  
  if (options.json) {
    console.log(JSON.stringify(msg, null, 2));
    return;
  }
  
  console.log(formatMessage(msg));
  console.log();
  console.log("Parts:", msg.parts.length);
  for (const part of msg.parts) {
    console.log(`  - ${part.type}${part.text ? `: ${part.text.slice(0, 100)}` : ""}`);
  }
}

async function cmdPrompt(
  sessionID: string,
  message: string,
  options: PromptOptions,
): Promise<void> {
  const result = await sendPrompt(sessionID, message, {
    agent: options.agent,
    noReply: options.noReply,
    outputFormat: options.outputFormat,
  });
  
  console.log(JSON.stringify(result, null, 2));
}

async function cmdCommand(sessionID: string, command: string, args: string[]): Promise<void> {
  const result = await sendCommand(sessionID, command, args);
  
  console.log(JSON.stringify(result, null, 2));
}

async function cmdShell(
  sessionID: string,
  command: string,
  options: { agent?: string },
): Promise<void> {
  const result = await runShell(sessionID, command, options);
  
  console.log(JSON.stringify(result, null, 2));
}

async function cmdRevert(
  sessionID: string,
  messageID: string,
  options: { json?: boolean },
): Promise<void> {
  const session = await revertMessage(sessionID, messageID);

  if (options.json) {
    console.log(JSON.stringify(session, null, 2));
    return;
  }

  console.log(`Reverted message ${messageID} in session ${session.id}`);
}

async function cmdUnrevert(
  sessionID: string,
  options: { json?: boolean },
): Promise<void> {
  const session = await unrevertSession(sessionID);

  if (options.json) {
    console.log(JSON.stringify(session, null, 2));
    return;
  }

  console.log(`Unreverted session: ${session.id}`);
}

async function cmdInit(
  sessionID: string,
  options: { messageID?: string; model?: string; json?: boolean },
): Promise<void> {
  const initialized = await initSession(sessionID, {
    messageID: options.messageID,
    model: options.model,
  });

  if (!initialized) {
    console.error(`Session not found: ${sessionID}`);
    process.exit(1);
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          action: "init",
          sessionID,
          messageID: options.messageID,
          model: options.model,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`Initialized session: ${sessionID}`);
}

async function cmdPermissions(options: {
  session?: string;
  json?: boolean;
}): Promise<void> {
  const permissions = await listPermissions(options.session);
  const filtered = options.session
    ? permissions.filter((item) => item.sessionID === options.session)
    : permissions;

  if (options.json) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }

  if (filtered.length === 0) {
    console.log("No pending permissions.");
    return;
  }

  for (const request of filtered) {
    console.log(`Permission: ${request.id}`);
    console.log(`  Session:    ${request.sessionID}`);
    console.log(`  Kind:       ${request.permission}`);
    console.log(`  Patterns:   ${request.patterns.join(", ")}`);
    if (request.tool) {
      console.log(`  Tool:       ${request.tool.callID} (${request.tool.messageID})`);
    }
    if (Object.keys(request.metadata).length > 0) {
      console.log(`  Metadata:   ${JSON.stringify(request.metadata)}`);
    }
    console.log();
  }
}

async function cmdPermission(
  sessionID: string,
  permissionID: string,
  response:
    | "allow"
    | "deny"
    | "allow-session"
    | "deny-session"
    | "once"
    | "always"
    | "reject",
  options: { json?: boolean },
): Promise<void> {
  const responded = await respondToPermission(sessionID, permissionID, response);

  if (!responded) {
    console.error(`Permission not found: ${permissionID} in session ${sessionID}`);
    process.exit(1);
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        { ok: true, sessionID, permissionID, response },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`Responded to permission ${permissionID}: ${response}`);
}

async function cmdStats(options: { json?: boolean }): Promise<void> {
  const stats = await getStats();
  
  if (options.json) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }
  
  console.log("Session Statistics");
  console.log("==================\n");
  console.log(`Total sessions:     ${stats.totalSessions}`);
  console.log(`Total turns:        ${stats.totalTurns.toLocaleString()}`);
  console.log(`Total tokens:       ${(stats.totalTokens.input + stats.totalTokens.output + stats.totalTokens.reasoning).toLocaleString()}`);
  console.log(`  - Input:          ${stats.totalTokens.input.toLocaleString()}`);
  console.log(`  - Output:         ${stats.totalTokens.output.toLocaleString()}`);
  console.log(`  - Reasoning:      ${stats.totalTokens.reasoning.toLocaleString()}`);
  console.log(`Avg turns/session:  ${stats.averageTurnsPerSession}`);
  console.log(`Avg tokens/session: ${stats.averageTokensPerSession.toLocaleString()}`);
  
  if (stats.oldestSession) {
    console.log(`\nOldest session:     ${stats.oldestSession.title} (${formatTime(stats.oldestSession.time.created)})`);
  }
  if (stats.newestSession) {
    console.log(`Newest session:     ${stats.newestSession.title} (${formatTime(stats.newestSession.time.updated)})`);
  }
}

function printHelp(): void {
  console.log(`
Session Management CLI Harness - Full API

Usage:
  opx-session <command> [options]

Session Management:
  list [--limit N] [--json]              List all sessions
  get <session-id> [--json]              Get session details
  children <session-id> [--json]         List child sessions
  create [--title "title"] [--parent] [--json]
                                         Create a new session
  update <session-id> [--title "new"] [--json]
                                         Update session properties
  delete <session-id> [--json]           Delete a session
  abort <session-id> [--json]            Abort a running session
  share <session-id> [--json]            Share a session
  unshare <session-id> [--json]          Unshare a session
  summarize <session-id> --model provider/model [--json]
                                         Start session summarization
  init <session-id> --message-id <id> --model provider/model [--json]
                                         Initialize a session from a message/model
  permissions [--session <id>] [--json] List pending permission requests

Messages:
  messages <session-id> [--limit N]      List messages in session
  message <session-id> <message-id>      Get single message details
  transcript <session-id> [--json] [--output PATH | --tee-temp]
                                         Render a transcript from the live session
  transcript --input <export.json> [--json] [--output PATH | --tee-temp]
                                         Render a transcript from a saved export

Interaction:
  prompt <session-id> <message> [--agent NAME] [--no-reply]
  command <session-id> <command> [args]  Send command to session
  shell <session-id> <command> [--agent NAME]
                                         Run a shell command in session

History:
  revert <session-id> <message-id> [--json]
                                         Revert a message
  unrevert <session-id> [--json]         Restore reverted messages

Permissions:
  permission <session-id> <permission-id> <once|always|reject> [--json]
                                         Aliases: allow=once, allow-session=always,
                                         deny/deny-session/reject=reject

Statistics:
  stats [--json]                         Show session statistics

Options:
  --json         Output as JSON
  --limit N      Limit results
  --input PATH   Render transcript from an exported JSON file
  --json         Output as JSON
  --agent NAME   Agent to use for prompt or shell commands
  --no-reply     Don't wait for AI response (prompt only)
  --output PATH  Save transcript to a file instead of streaming
  --tee-temp     Stream transcript and also save it to a temp file

Environment:
  OPENCODE_BASE_URL   Server URL (default: http://localhost:4096)
  OPENCODE_API_KEY    API key for authentication

Examples:
  opx-session list --limit 10
  opx-session messages ses_abc123 --json
  opx-session transcript ses_abc123
  opx-session transcript ses_abc123 --json
  opx-session transcript --input ./session-export.json
  opx-session transcript ses_abc123 --tee-temp
  opx-session create --title "test" --parent ses_xyz
  opx-session prompt ses_abc123 "hello" --agent Minimal --no-reply
  opx-session summarize ses_abc123 --model github-copilot/gpt-4.1
  opx-session stats
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  
  const command = args[0];
  const options: Record<string, string | boolean | number> = {};
  const positional: string[] = [];
  
  // Parse arguments
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const nextArg = args[i + 1];
      
      if (nextArg && !nextArg.startsWith("--")) {
        if (!isNaN(Number(nextArg))) {
          options[key] = Number(nextArg);
        } else {
          options[key] = nextArg;
        }
        i++;
      } else {
        options[key] = true;
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      // Short flag - skip for now (not implemented)
    } else {
      positional.push(arg);
    }
  }
  
  try {
    switch (command) {
      case "list":
        await cmdList({
          limit: options.limit as number | undefined,
          json: !!options.json,
        });
        break;
        
      case "get":
        if (!positional[0]) {
          console.error("Error: session ID required");
          process.exit(1);
        }
        await cmdGet(positional[0], { json: !!options.json });
        break;
        
      case "children":
        if (!positional[0]) {
          console.error("Error: session ID required");
          process.exit(1);
        }
        await cmdChildren(positional[0], { json: !!options.json });
        break;
        
      case "create":
        await cmdCreate({
          title: options.title as string | undefined,
          parent: options.parent as string | undefined,
          json: !!options.json,
        });
        break;
        
      case "update":
        if (!positional[0]) {
          console.error("Error: session ID required");
          process.exit(1);
        }
        await cmdUpdate(positional[0], {
          title: options.title as string | undefined,
          json: !!options.json,
        });
        break;
        
      case "delete":
        if (!positional[0]) {
          console.error("Error: session ID required");
          process.exit(1);
        }
        await cmdDelete(positional[0], { json: !!options.json });
        break;
        
      case "abort":
        if (!positional[0]) {
          console.error("Error: session ID required");
          process.exit(1);
        }
        await cmdAbort(positional[0], { json: !!options.json });
        break;
        
      case "share":
        if (!positional[0]) {
          console.error("Error: session ID required");
          process.exit(1);
        }
        await cmdShare(positional[0], { json: !!options.json });
        break;
        
      case "unshare":
        if (!positional[0]) {
          console.error("Error: session ID required");
          process.exit(1);
        }
        await cmdUnshare(positional[0], { json: !!options.json });
        break;
        
      case "summarize":
        if (!positional[0]) {
          console.error("Error: session ID required");
          process.exit(1);
        }
        await cmdSummarize(positional[0], {
          model: options.model as string | undefined,
          json: !!options.json,
        });
        break;
        
      case "init":
        if (!positional[0]) {
          console.error("Error: session ID required");
          process.exit(1);
        }
        await cmdInit(positional[0], {
          messageID:
            (options["message-id"] as string | undefined) ??
            (options.messageID as string | undefined),
          model: options.model as string | undefined,
          json: !!options.json,
        });
        break;

      case "permissions":
        await cmdPermissions({
          session: options.session as string | undefined,
          json: !!options.json,
        });
        break;
        
      case "messages":
        if (!positional[0]) {
          console.error("Error: session ID required");
          process.exit(1);
        }
        await cmdMessages(positional[0], {
          limit: options.limit as number | undefined,
          json: !!options.json,
        });
        break;
        
      case "message":
        if (!positional[0] || !positional[1]) {
          console.error("Error: session ID and message ID required");
          process.exit(1);
        }
        await cmdMessage(positional[0], positional[1], { json: !!options.json });
        break;

      case "transcript":
        if (!!positional[0] === !!options.input) {
          console.error(
            "Error: provide exactly one of <session-id> or --input <path>",
          );
          process.exit(1);
        }
        await cmdTranscript(
          {
            input: options.input as string | undefined,
            sessionID: positional[0],
          },
          {
          json: !!options.json,
          output: options.output as string | undefined,
          teeTemp: !!options["tee-temp"] || !!options.teeTemp,
          },
        );
        break;
        
      case "prompt":
        if (!positional[0] || !positional[1]) {
          console.error("Error: session ID and message required");
          process.exit(1);
        }
        await cmdPrompt(positional[0], positional[1], {
          agent: options.agent as string | undefined,
          noReply: !!options["no-reply"] || !!options.noReply,
          outputFormat: options["output-format"] as string | undefined,
        });
        break;
        
      case "command":
        if (!positional[0] || !positional[1]) {
          console.error("Error: session ID and command required");
          process.exit(1);
        }
        await cmdCommand(positional[0], positional[1], positional.slice(2));
        break;
        
      case "shell":
        if (!positional[0] || !positional[1]) {
          console.error("Error: session ID and command required");
          process.exit(1);
        }
        await cmdShell(positional[0], positional[1], {
          agent: options.agent as string | undefined,
        });
        break;
        
      case "revert":
        if (!positional[0] || !positional[1]) {
          console.error("Error: session ID and message ID required");
          process.exit(1);
        }
        await cmdRevert(positional[0], positional[1], { json: !!options.json });
        break;
        
      case "unrevert":
        if (!positional[0]) {
          console.error("Error: session ID required");
          process.exit(1);
        }
        await cmdUnrevert(positional[0], { json: !!options.json });
        break;
        
      case "permission":
        if (!positional[0] || !positional[1] || !positional[2]) {
          console.error("Error: session ID, permission ID, and response required");
          process.exit(1);
        }
        await cmdPermission(
          positional[0],
          positional[1],
          positional[2] as
            | "allow"
            | "deny"
            | "allow-session"
            | "deny-session"
            | "once"
            | "always"
            | "reject",
          { json: !!options.json },
        );
        break;
        
      case "stats":
        await cmdStats({ json: !!options.json });
        break;
        
      default:
        console.error(`Unknown command: ${command}`);
        console.error("Run with --help for usage");
        process.exit(1);
    }
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

// Export for programmatic use
export {
  listSessions,
  getSession,
  getChildSessions,
  createSession,
  updateSession,
  deleteSession,
  abortSession,
  shareSession,
  unshareSession,
  summarizeSession,
  getMessages,
  getMessage,
  buildPromptRequestBody,
  sendPrompt,
  sendCommand,
  runShell,
  revertMessage,
  unrevertSession,
  initSession,
  respondToPermission,
  renderInputTranscript,
  renderSessionTranscript,
  getStats,
};

// Run CLI only when this file is executed directly.
if (import.meta.main) {
  main();
}
