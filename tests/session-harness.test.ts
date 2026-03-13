import { describe, expect, it } from "bun:test";

import { buildPromptRequestBody } from "../src/session-harness";

describe("session-harness prompt body", () => {
  it("preserves the direct prompt text without an explicit agent override", () => {
    expect(buildPromptRequestBody("Call improved_todowrite directly.")).toEqual(
      {
        parts: [
          {
            type: "text",
            text: "Call improved_todowrite directly.",
          },
        ],
      },
    );
  });

  it("includes an explicit agent override for session prompts", () => {
    expect(
      buildPromptRequestBody(
        "Call improved_todowrite directly.",
        { agent: "Minimal" },
      ),
    ).toEqual({
      agent: "Minimal",
      parts: [
        {
          type: "text",
          text: "Call improved_todowrite directly.",
        },
      ],
    });
  });
});
