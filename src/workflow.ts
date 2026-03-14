import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ModelRef = {
  modelID: string;
  providerID: string;
};

export type SessionContext = {
  directory?: string;
  workspaceID?: string;
};

export type WorkflowVisibility = "chat" | "system";

export type StoredResponderIdentity = {
  agent: string;
  model: ModelRef;
};

export type WorkflowSessionState = SessionContext & {
  createdAt: number;
  model: ModelRef | null;
  responderAgent: string | null;
  sessionID: string;
  title: string;
};

type PromptBodyInput = {
  identity: StoredResponderIdentity;
  prompt: string;
  visibility: WorkflowVisibility;
};

type RenderWorkflowOutputInput = {
  assistantMessages: string[];
  transcript: string;
  transcriptRequested: boolean;
};

function stateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(
    env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "opencode-manager",
    "sessions",
  );
}

function stateFile(sessionID: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(stateRoot(env), `${sessionID}.json`);
}

export function formatModelRef(model: ModelRef): string {
  return `${model.providerID}/${model.modelID}`;
}

export function parseModelRef(model: string): ModelRef {
  const [providerID, ...rest] = model.split("/");
  const modelID = rest.join("/");
  if (!providerID || !modelID) {
    throw new Error("Model must use the form provider/model.");
  }
  return { modelID, providerID };
}

export function requireStoredIdentity(
  state: Pick<WorkflowSessionState, "model" | "responderAgent">,
): StoredResponderIdentity {
  if (
    !state.responderAgent ||
    !state.model?.providerID ||
    !state.model?.modelID
  ) {
    throw new Error(
      "Stored responder identity is incomplete. Start a new session with both --agent and --model.",
    );
  }
  return {
    agent: state.responderAgent,
    model: state.model,
  };
}

export function buildPromptBody(input: PromptBodyInput): {
  agent: string;
  model: ModelRef;
  parts: Array<{ text: string; type: "text" }>;
  system?: string;
} {
  const identity = requireStoredIdentity({
    model: input.identity.model,
    responderAgent: input.identity.agent,
  });

  if (input.visibility === "system") {
    return {
      agent: identity.agent,
      model: identity.model,
      parts: [],
      system: input.prompt,
    };
  }

  return {
    agent: identity.agent,
    model: identity.model,
    parts: [{ text: input.prompt, type: "text" }],
  };
}

export function renderWorkflowOutput(
  input: RenderWorkflowOutputInput,
): string {
  if (input.transcriptRequested) {
    return input.transcript;
  }

  const lastAssistant = input.assistantMessages.at(-1)?.trim();
  if (!lastAssistant) {
    throw new Error("No assistant reply was recorded for the completed command.");
  }
  return lastAssistant;
}

export async function saveWorkflowState(
  state: WorkflowSessionState,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const file = stateFile(state.sessionID, env);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return file;
}

export async function loadWorkflowState(
  sessionID: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WorkflowSessionState> {
  const file = stateFile(sessionID, env);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `No stored workflow session metadata exists for ${sessionID}. Begin a new session before using continued-session commands.`,
      );
    }
    throw error;
  }

  const parsed = JSON.parse(raw) as WorkflowSessionState;
  if (parsed.sessionID !== sessionID) {
    throw new Error(
      `Stored workflow metadata for ${sessionID} is invalid and cannot be trusted.`,
    );
  }
  return parsed;
}

export async function deleteWorkflowState(
  sessionID: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const file = stateFile(sessionID, env);
  await rm(file, { force: true });
}
