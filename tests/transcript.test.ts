import { expect, test } from "bun:test";

import fixture from "./fixtures/transcript-multiturn.json";
import sampleExport from "./fixtures/sample-export.json";
import { renderTranscriptMarkdown } from "../src/transcript";

function assertOrdered(text: string, fragments: string[]) {
  let cursor = -1;
  for (const fragment of fragments) {
    const next = text.indexOf(fragment, cursor + 1);
    expect(next).toBeGreaterThan(cursor);
    cursor = next;
  }
}

test("renders a multi-turn transcript with ordered steps and exact durations", () => {
  const rendered = renderTranscriptMarkdown(fixture, {
    generatedAtMs: 1773332600000,
  });

  expect(rendered).toContain("# OpenCode Session Transcript");
  expect(rendered).toContain(
    "- Confirmed session ID: `ses_31df77a2effeFkeVNZmfvgo5Mo`",
  );
  expect(rendered).toContain("- Turns: 2");
  expect(rendered).toContain("- Agent steps: 9");
  expect(rendered).toContain("- Generated at: 2026-03-12T16:23:20.000Z");
  expect(rendered).toContain("## Turn 1");
  expect(rendered).toContain("- Duration: 8.266s");
  expect(rendered).toContain("- Agent messages: 2");
  expect(rendered).toContain("- Agent steps: 6");
  expect(rendered).toContain("Prompt:");
  expect(rendered).toContain(
    "    Use introspection to get this session ID, then reply with SESSION_OK.",
  );
  expect(rendered).toContain("### Agent Message 1");
  expect(rendered).toContain("- Finish: `tool-calls`");
  expect(rendered).toContain("#### Step 2 `tool:introspection`");
  expect(rendered).toContain("- Duration: 0.009s");
  expect(rendered).toContain(
    "    Session ID: ses_31df77a2effeFkeVNZmfvgo5Mo",
  );
  expect(rendered).toContain("### Agent Message 2");
  expect(rendered).toContain("    SESSION_OK");
  expect(rendered).toContain("## Turn 2");
  expect(rendered).toContain("- Duration: 4.140s");
  expect(rendered).toContain("    Reply with ONLY SECOND_OK.");
  expect(rendered).toContain("    SECOND_OK");

  assertOrdered(rendered, [
    "## Turn 1",
    "### Agent Message 1",
    "#### Step 2 `tool:introspection`",
    "### Agent Message 2",
    "## Turn 2",
    "### Agent Message 1",
    "    SECOND_OK",
  ]);
});

test("includes the saved copy path in the transcript header when requested", () => {
  const rendered = renderTranscriptMarkdown(fixture, {
    generatedAtMs: 1773332600000,
    savedCopyPath: "/tmp/opx-session-ses_31df77a2effeFkeVNZmfvgo5Mo.md",
  });

  expect(rendered).toContain(
    "- Saved copy: `/tmp/opx-session-ses_31df77a2effeFkeVNZmfvgo5Mo.md`",
  );
  expect(rendered).toContain("- Turns: 2");
  expect(rendered).toContain("## Turn 2");
});

test("renders reasoning and legacy tool timing from exported JSON fixtures", () => {
  const rendered = renderTranscriptMarkdown(sampleExport, {
    generatedAtMs: 1773332600000,
  });

  expect(rendered).toContain("- Confirmed session ID: `ses_fixture`");
  expect(rendered).toContain("- Turns: 1");
  expect(rendered).toContain("- Agent steps: 3");
  expect(rendered).toContain("## Turn 1");
  expect(rendered).toContain("#### Step 1 `reasoning`");
  expect(rendered).toContain(
    "    Reason about whether a tool is needed.",
  );
  expect(rendered).toContain("#### Step 2 `tool:webfetch`");
  expect(rendered).toContain("- Duration: 0.420s (legacy tool timing)");
  expect(rendered).toContain("Input:");
  expect(rendered).toContain("    \"url\": \"https://example.com\"");
  expect(rendered).toContain("Output:");
  expect(rendered).toContain("    example output");
  expect(rendered).toContain("#### Step 3 `text`");
  expect(rendered).toContain("    Hello.");

  assertOrdered(rendered, [
    "#### Step 1 `reasoning`",
    "Reason about whether a tool is needed.",
    "#### Step 2 `tool:webfetch`",
    "example output",
    "#### Step 3 `text`",
    "Hello.",
  ]);
});
