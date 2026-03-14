import { describe, expect, it } from "bun:test";

import {
  assistantCompletionRequiresContinuation,
  buildPromptBody,
  extractObservedIdentity,
  latestAssistantMessageSince,
  latestAssistantMessage,
  renderWorkflowOutput,
} from "../src/workflow";

const identity = {
  agent: "Minimal",
  model: {
    modelID: "claude-sonnet-4.6",
    providerID: "github-copilot",
  },
};

describe("workflow helpers", () => {
  it("builds a visible chat prompt with fixed responder identity", () => {
    expect(
      buildPromptBody({
        identity,
        prompt: "Call improved_todowrite directly.",
        visibility: "chat",
      }),
    ).toEqual({
      agent: "Minimal",
      model: {
        modelID: "claude-sonnet-4.6",
        providerID: "github-copilot",
      },
      parts: [
        {
          type: "text",
          text: "Call improved_todowrite directly.",
        },
      ],
    });
  });

  it("builds an agent-only system prompt without a user-visible message part", () => {
    expect(
      buildPromptBody({
        identity,
        prompt: "Stay terse and ask for exact paths before shelling out.",
        visibility: "system",
      }),
    ).toEqual({
      agent: "Minimal",
      model: {
        modelID: "claude-sonnet-4.6",
        providerID: "github-copilot",
      },
      parts: [],
      system: "Stay terse and ask for exact paths before shelling out.",
    });
  });

  it("omits responder identity when no assistant history exists yet", () => {
    expect(extractObservedIdentity([])).toEqual({});
    expect(
      buildPromptBody({
        identity: {},
        prompt: "Use configured defaults.",
        visibility: "chat",
      }),
    ).toEqual({
      parts: [
        {
          type: "text",
          text: "Use configured defaults.",
        },
      ],
    });
  });

  it("derives continuation identity from the latest message carrying responder fields", () => {
    const messages = [
      {
        info: {
          agent: "Interactive",
          modelID: "gemini-2.5-pro",
          providerID: "google",
          role: "assistant",
        },
      },
      {
        info: {
          agent: "Minimal",
          model: {
            modelID: "claude-sonnet-4.6",
            providerID: "github-copilot",
          },
          role: "user",
        },
      },
    ];
    expect(extractObservedIdentity(messages)).toEqual({
      agent: "Minimal",
      model: {
        modelID: "claude-sonnet-4.6",
        providerID: "github-copilot",
      },
    });
  });

  it("returns the last assistant message by default and the transcript when requested", () => {
    const transcript = "# OpenCode Session Transcript\n\nhello";

    expect(latestAssistantMessage(["first", "final answer"])).toBe("final answer");
    expect(latestAssistantMessage(["   ", ""])).toBeNull();

    expect(
      renderWorkflowOutput({
        assistantMessages: ["first", "final answer"],
        transcript,
        transcriptRequested: false,
      }),
    ).toBe("final answer");

    expect(
      renderWorkflowOutput({
        assistantMessages: ["first", "final answer"],
        transcript,
        transcriptRequested: true,
      }),
    ).toBe(transcript);
  });

  it("fails loudly when no assistant reply exists for a terminal command", () => {
    expect(() =>
      renderWorkflowOutput({
        assistantMessages: [],
        transcript: "# OpenCode Session Transcript\n\nempty",
        transcriptRequested: false,
      }),
    ).toThrow("No assistant reply was recorded");
  });

  it("preserves a non-default observed model in later prompt bodies", () => {
    const identity = extractObservedIdentity([
      {
        info: {
          agent: "Minimal",
          modelID: "o3",
          providerID: "openai",
          role: "assistant",
        },
      },
    ]);

    expect(identity).toEqual({
      agent: "Minimal",
      model: {
        modelID: "o3",
        providerID: "openai",
      },
    });

    expect(
      buildPromptBody({
        identity,
        prompt: "Continue with the same responder.",
        visibility: "chat",
      }),
    ).toEqual({
      agent: "Minimal",
      model: {
        modelID: "o3",
        providerID: "openai",
      },
      parts: [
        {
          type: "text",
          text: "Continue with the same responder.",
        },
      ],
    });
  });

  it("treats tool-calls completions as needing a follow-up assistant message", () => {
    expect(assistantCompletionRequiresContinuation("tool-calls")).toBe(true);
    expect(assistantCompletionRequiresContinuation("stop")).toBe(false);
    expect(assistantCompletionRequiresContinuation(undefined)).toBe(false);
  });

  it("returns only assistant text recorded after the awaited turn started", () => {
    const messages = [
      {
        info: { role: "assistant" },
        parts: [{ type: "text", text: "READY" }],
      },
      {
        info: { finish: "tool-calls", role: "assistant" },
        parts: [{ type: "tool" }],
      },
      {
        info: { finish: "stop", role: "assistant" },
        parts: [{ type: "text", text: "LISTED" }],
      },
    ];

    expect(latestAssistantMessageSince(messages, 1)).toBe("LISTED");
  });

  it("does not fall back to stale assistant text when the awaited turn emitted none", () => {
    const messages = [
      {
        info: { role: "assistant" },
        parts: [{ type: "text", text: "READY" }],
      },
      {
        info: { finish: "tool-calls", role: "assistant" },
        parts: [{ type: "tool" }],
      },
      {
        info: { finish: "unknown", role: "assistant" },
        parts: [],
      },
    ];

    expect(latestAssistantMessageSince(messages, 1)).toBeNull();
  });
});
