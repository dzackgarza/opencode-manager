interface TranscriptInfo {
  [key: string]: any;
}

export interface TranscriptMessage {
  info: TranscriptInfo;
  parts: TranscriptPart[];
}

export interface TranscriptPart {
  [key: string]: any;
}

export interface TranscriptExport {
  info: TranscriptInfo;
  messages: TranscriptMessage[];
}

type TranscriptStep = {
  completedMs: number | null;
  completedSource: string | null;
  durationHintMs: number | null;
  durationHintSource: string | null;
  heading: string;
  index: number;
  part: TranscriptPart;
  startedMs: number | null;
  startedSource: string | null;
};

type TranscriptTurn = {
  assistantMessages: TranscriptMessage[];
  completedMs: number | null;
  index: number;
  startedMs: number | null;
  userMessage: TranscriptMessage | null;
};

type RenderTranscriptOptions = {
  generatedAtMs?: number;
  savedCopyPath?: string;
};

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isoTimestamp(epochMs: number | null): string {
  if (epochMs === null) {
    return "unknown";
  }
  return new Date(epochMs).toISOString();
}

function durationText(startMs: number | null, endMs: number | null): string {
  if (startMs === null || endMs === null) {
    return "unknown";
  }
  const durationMs = Math.max(0, endMs - startMs);
  return `${(durationMs / 1000).toFixed(3)}s`;
}

function hintedDurationText(
  startMs: number | null,
  endMs: number | null,
  hintMs: number | null,
  hintSource: string | null,
): string {
  if (hintMs !== null) {
    const rendered = `${(hintMs / 1000).toFixed(3)}s`;
    return hintSource ? `${rendered} (${hintSource})` : rendered;
  }
  return durationText(startMs, endMs);
}

function messageCreatedMs(message: TranscriptMessage | null): number | null {
  return asNumber(message?.info?.time?.created);
}

function messageCompletedMs(message: TranscriptMessage | null): number | null {
  return (
    asNumber(message?.info?.time?.completed) ??
    asNumber(message?.info?.time?.created)
  );
}

function sessionModel(info: TranscriptInfo): string {
  if (info?.providerID && info?.modelID) {
    return `${info.providerID}/${info.modelID}`;
  }
  if (info?.model?.providerID && info?.model?.modelID) {
    return `${info.model.providerID}/${info.model.modelID}`;
  }
  if (typeof info?.model === "string") {
    return info.model;
  }
  if (typeof info?.model?.modelID === "string") {
    return info.model.modelID;
  }
  return "unknown";
}

function renderTokens(tokens: any): string {
  if (!tokens) {
    return "unknown";
  }

  const parts = [
    `input ${tokens.input ?? 0}`,
    `output ${tokens.output ?? 0}`,
    `reasoning ${tokens.reasoning ?? 0}`,
  ];
  const cache = tokens.cache ?? {};
  parts.push(`cache read ${cache.read ?? 0}`);
  parts.push(`cache write ${cache.write ?? 0}`);
  if (typeof tokens.total === "number") {
    parts.unshift(`total ${tokens.total}`);
  }
  return parts.join("; ");
}

function textParts(parts: TranscriptPart[]): string {
  return parts
    .filter((part) => part?.type === "text" && typeof part?.text === "string")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

function indentBlock(text: string): string[] {
  if (!text.trim()) {
    return ["    (empty)"];
  }
  return text.split("\n").map((line) => `    ${line}`);
}

function renderBlock(label: string, value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }

  const rendered =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);

  return [label, ...indentBlock(rendered)];
}

function stepHeading(part: TranscriptPart): string {
  switch (part?.type) {
    case "tool":
      return `tool:${part.tool ?? "unknown"}`;
    case "text":
      return "text";
    case "reasoning":
      return "reasoning";
    case "step-start":
      return "step-start";
    case "step-finish":
      return "step-finish";
    case "patch":
      return "patch";
    default:
      return String(part?.type ?? "unknown");
  }
}

function partDurationHint(part: TranscriptPart): {
  source: string | null;
  value: number | null;
} {
  if (typeof part?.timing?.latency_s === "number") {
    return {
      source: "legacy tool timing",
      value: Math.max(0, Math.round(part.timing.latency_s * 1000)),
    };
  }
  return { source: null, value: null };
}

function partStartedMs(
  part: TranscriptPart,
  message: TranscriptMessage,
): { source: string | null; value: number | null } {
  switch (part?.type) {
    case "tool":
      return {
        source: part?.state?.time?.start ? "tool state" : null,
        value: asNumber(part?.state?.time?.start),
      };
    case "text":
    case "reasoning":
    case "patch":
      return {
        source: part?.time?.start ? `${part.type} part` : null,
        value: asNumber(part?.time?.start),
      };
    case "step-start":
      return {
        source: "assistant message start",
        value: messageCreatedMs(message),
      };
    case "step-finish":
      return {
        source: "assistant message completion",
        value: messageCompletedMs(message),
      };
    default:
      return { source: null, value: null };
  }
}

function partCompletedMs(
  part: TranscriptPart,
  message: TranscriptMessage,
): { source: string | null; value: number | null } {
  switch (part?.type) {
    case "tool":
      return {
        source: part?.state?.time?.end ? "tool state" : null,
        value: asNumber(part?.state?.time?.end),
      };
    case "text":
    case "reasoning":
    case "patch":
      return {
        source: part?.time?.end ? `${part.type} part` : null,
        value: asNumber(part?.time?.end),
      };
    case "step-start":
      return {
        source: "assistant message start",
        value: messageCreatedMs(message),
      };
    case "step-finish":
      return {
        source: "assistant message completion",
        value: messageCompletedMs(message),
      };
    default:
      return { source: null, value: null };
  }
}

function buildSteps(message: TranscriptMessage): TranscriptStep[] {
  const steps = (message.parts ?? []).map((part, index) => {
    const started = partStartedMs(part, message);
    const completed = partCompletedMs(part, message);
    const durationHint = partDurationHint(part);
    return {
      completedMs: completed.value,
      completedSource: completed.source,
      durationHintMs: durationHint.value,
      durationHintSource: durationHint.source,
      heading: stepHeading(part),
      index: index + 1,
      part,
      startedMs: started.value,
      startedSource: started.source,
    };
  });

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step.startedMs === null) {
      const previous = steps[index - 1];
      step.startedMs =
        previous?.completedMs ?? previous?.startedMs ?? messageCreatedMs(message);
      step.startedSource = previous
        ? "previous step boundary"
        : "assistant message start";
    }
  }

  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step.completedMs === null) {
      const next = steps[index + 1];
      step.completedMs =
        next?.startedMs ?? next?.completedMs ?? messageCompletedMs(message);
      step.completedSource = next
        ? "next step boundary"
        : "assistant message completion";
    }
  }

  for (const step of steps) {
    if (step.startedMs === null && step.completedMs !== null) {
      step.startedMs = step.completedMs;
      step.startedSource = step.completedSource;
    }
    if (step.completedMs === null && step.startedMs !== null) {
      step.completedMs = step.startedMs;
      step.completedSource = step.startedSource;
    }
    if (
      step.startedMs !== null &&
      step.completedMs !== null &&
      step.completedMs < step.startedMs
    ) {
      step.completedMs = step.startedMs;
      if (!step.completedSource) {
        step.completedSource = step.startedSource;
      }
    }
  }

  return steps;
}

function buildTurns(messages: TranscriptMessage[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let current: TranscriptTurn | null = null;

  for (const message of messages) {
    const role = message?.info?.role;
    if (role === "user") {
      if (current) {
        turns.push(current);
      }
      current = {
        assistantMessages: [],
        completedMs: messageCompletedMs(message),
        index: turns.length + 1,
        startedMs: messageCreatedMs(message),
        userMessage: message,
      };
      continue;
    }

    if (!current) {
      current = {
        assistantMessages: [],
        completedMs: null,
        index: turns.length + 1,
        startedMs: messageCreatedMs(message),
        userMessage: null,
      };
    }

    current.assistantMessages.push(message);
    current.startedMs = current.startedMs ?? messageCreatedMs(message);
    current.completedMs = messageCompletedMs(message) ?? current.completedMs;
  }

  if (current) {
    turns.push(current);
  }

  return turns;
}

function renderStep(step: TranscriptStep): string[] {
  const lines = [`#### Step ${step.index} \`${step.heading}\``];
  lines.push(`- Started: ${isoTimestamp(step.startedMs)}${step.startedSource ? ` (${step.startedSource})` : ""}`);
  lines.push(`- Completed: ${isoTimestamp(step.completedMs)}${step.completedSource ? ` (${step.completedSource})` : ""}`);
  lines.push(
    `- Duration: ${hintedDurationText(
      step.startedMs,
      step.completedMs,
      step.durationHintMs,
      step.durationHintSource,
    )}`,
  );

  switch (step.part?.type) {
    case "tool":
      lines.push(`- Call ID: \`${step.part.callID ?? "unknown"}\``);
      lines.push(`- Status: \`${step.part?.state?.status ?? "unknown"}\``);
      lines.push(...renderBlock("Input:", step.part?.state?.input ?? {}));
      if (step.part?.state?.output !== undefined) {
        lines.push(...renderBlock("Output:", step.part.state.output));
      }
      break;
    case "text":
    case "reasoning":
      lines.push(...renderBlock("Content:", step.part?.text ?? ""));
      break;
    case "step-start":
      if (step.part?.snapshot) {
        lines.push(`- Snapshot: \`${step.part.snapshot}\``);
      }
      break;
    case "step-finish":
      if (step.part?.reason) {
        lines.push(`- Reason: \`${step.part.reason}\``);
      }
      if (step.part?.snapshot) {
        lines.push(`- Snapshot: \`${step.part.snapshot}\``);
      }
      if (step.part?.tokens) {
        lines.push(`- Tokens: ${renderTokens(step.part.tokens)}`);
      }
      break;
    case "patch":
      lines.push(...renderBlock("Patch:", step.part?.text ?? step.part));
      break;
    default:
      lines.push(...renderBlock("Data:", step.part));
      break;
  }

  return lines;
}

function renderAssistantMessage(
  message: TranscriptMessage,
  index: number,
): string[] {
  const steps = buildSteps(message);
  const info = message.info ?? {};
  const lines = [`### Agent Message ${index}`];
  lines.push(`- Message ID: \`${info.id ?? "unknown"}\``);
  lines.push(`- Started: ${isoTimestamp(messageCreatedMs(message))}`);
  lines.push(`- Completed: ${isoTimestamp(messageCompletedMs(message))}`);
  lines.push(
    `- Duration: ${durationText(messageCreatedMs(message), messageCompletedMs(message))}`,
  );
  lines.push(`- Agent: \`${info.agent ?? "unknown"}\``);
  lines.push(`- Model: \`${sessionModel(info)}\``);
  lines.push(`- Finish: \`${info.finish ?? "unknown"}\``);
  lines.push(`- Tokens: ${renderTokens(info.tokens)}`);
  if (info?.path?.cwd || info?.path?.root) {
    lines.push(
      `- Path: cwd=\`${info?.path?.cwd ?? "unknown"}\` root=\`${info?.path?.root ?? "unknown"}\``,
    );
  }
  lines.push(`- Steps: ${steps.length}`);
  lines.push("");

  for (const step of steps) {
    lines.push(...renderStep(step));
    lines.push("");
  }

  return lines;
}

function renderUserMessage(message: TranscriptMessage | null): string[] {
  if (!message) {
    return ["### User", "- Missing user message for this turn", ""];
  }

  const lines = ["### User"];
  lines.push(`- Message ID: \`${message.info?.id ?? "unknown"}\``);
  lines.push(`- Started: ${isoTimestamp(messageCreatedMs(message))}`);
  lines.push(`- Parts: ${(message.parts ?? []).length}`);
  lines.push("");

  const body = textParts(message.parts ?? []);
  lines.push(...renderBlock("Prompt:", body || "(no text parts)"));
  lines.push("");
  return lines;
}

export function renderTranscriptMarkdown(
  data: TranscriptExport,
  options: RenderTranscriptOptions = {},
): string {
  const turns = buildTurns(data.messages ?? []);
  const assistantMessages = (data.messages ?? []).filter(
    (message) => message?.info?.role === "assistant",
  );
  const assistantSteps = assistantMessages.reduce(
    (count, message) => count + buildSteps(message).length,
    0,
  );

  const generatedAtMs = options.generatedAtMs ?? Date.now();
  const lines = [
    "# OpenCode Session Transcript",
    "",
    `- Confirmed session ID: \`${data.info?.id ?? "unknown"}\``,
    `- Title: ${data.info?.title ?? "unknown"}`,
    `- Directory: \`${data.info?.directory ?? "unknown"}\``,
    `- Session created: ${isoTimestamp(asNumber(data.info?.time?.created))}`,
    `- Session updated: ${isoTimestamp(asNumber(data.info?.time?.updated))}`,
    `- Turns: ${turns.length}`,
    `- Messages: ${(data.messages ?? []).length}`,
    `- Agent steps: ${assistantSteps}`,
    `- Generated at: ${isoTimestamp(generatedAtMs)}`,
  ];

  if (options.savedCopyPath) {
    lines.push(`- Saved copy: \`${options.savedCopyPath}\``);
  }

  lines.push("");

  for (const turn of turns) {
    const turnStart = turn.startedMs ?? messageCreatedMs(turn.userMessage);
    const turnEnd =
      turn.completedMs ??
      messageCompletedMs(turn.assistantMessages.at(-1) ?? turn.userMessage);
    const turnStepCount = turn.assistantMessages.reduce(
      (count, message) => count + buildSteps(message).length,
      0,
    );
    lines.push(`## Turn ${turn.index}`);
    lines.push(`- Started: ${isoTimestamp(turnStart)}`);
    lines.push(`- Completed: ${isoTimestamp(turnEnd)}`);
    lines.push(`- Duration: ${durationText(turnStart, turnEnd)}`);
    lines.push(`- Agent messages: ${turn.assistantMessages.length}`);
    lines.push(`- Agent steps: ${turnStepCount}`);
    lines.push("");
    lines.push(...renderUserMessage(turn.userMessage));

    if (turn.assistantMessages.length === 0) {
      lines.push("### Agent");
      lines.push("- No assistant messages recorded for this turn");
      lines.push("");
      continue;
    }

    turn.assistantMessages.forEach((message, index) => {
      lines.push(...renderAssistantMessage(message, index + 1));
    });
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
