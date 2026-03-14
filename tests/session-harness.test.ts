import { describe, expect, it } from "bun:test";

import {
  buildPromptBody,
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

  it("returns the last assistant message by default and the transcript when requested", () => {
    const transcript = "# OpenCode Session Transcript\n\nhello";

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

  it("normalizes missing responder identity into a continuation error", () => {
    expect(() =>
      buildPromptBody({
        identity: {
          agent: "",
          model: {
            modelID: "claude-sonnet-4.6",
            providerID: "github-copilot",
          },
        },
        prompt: "Hello",
        visibility: "chat",
      }),
    ).toThrow("Stored responder identity is incomplete");

    expect(() =>
      buildPromptBody({
        identity: {
          agent: "Minimal",
          model: {
            modelID: "",
            providerID: "github-copilot",
          },
        },
        prompt: "Hello",
        visibility: "chat",
      }),
    ).toThrow("Stored responder identity is incomplete");
  });
});
