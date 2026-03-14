export type ModelRef = {
  modelID: string;
  providerID: string;
};

export type WorkflowVisibility = "chat" | "system";

export type ResponderIdentity = {
  agent?: string;
  model?: ModelRef;
};

export type SessionMessageLike = {
  info?: {
    agent?: string;
    finish?: string;
    model?: ModelRef;
    modelID?: string;
    providerID?: string;
    role?: string;
  };
  parts?: Array<{
    text?: string;
    type?: string;
  }>;
};

type PromptBodyInput = {
  identity: ResponderIdentity;
  prompt: string;
  visibility: WorkflowVisibility;
};

type RenderWorkflowOutputInput = {
  assistantMessages: string[];
  transcript: string;
  transcriptRequested: boolean;
};

export function latestAssistantMessage(
  assistantMessages: string[],
): string | null {
  const lastAssistant = assistantMessages.at(-1)?.trim();
  return lastAssistant ? lastAssistant : null;
}

export function assistantCompletionRequiresContinuation(
  finish: string | null | undefined,
): boolean {
  return finish === "tool-calls";
}

function flattenAssistantText(parts: Array<{ text?: string; type?: string }> = []): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

export function latestAssistantMessageSince(
  messages: SessionMessageLike[],
  initialAssistantCount: number,
): string | null {
  const newAssistantTexts = messages
    .filter((message) => message.info?.role === "assistant")
    .slice(initialAssistantCount)
    .map((message) => flattenAssistantText(message.parts))
    .filter((text) => text.length > 0);

  return latestAssistantMessage(newAssistantTexts);
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

export function extractObservedIdentity(
  messages: SessionMessageLike[],
): ResponderIdentity {
  const message = [...messages]
    .reverse()
    .find((entry) => {
      const info = entry.info;
      return Boolean(
        info?.agent ||
          info?.model?.providerID ||
          (info?.providerID && info?.modelID),
      );
    });
  if (!message?.info) {
    return {};
  }

  return {
    ...(message.info.agent ? { agent: message.info.agent } : {}),
    ...(message.info.model
      ? { model: message.info.model }
      : message.info.providerID && message.info.modelID
      ? {
          model: {
            modelID: message.info.modelID,
            providerID: message.info.providerID,
          },
        }
      : {}),
  };
}

export function buildPromptBody(input: PromptBodyInput): {
  parts: Array<{ text: string; type: "text" }>;
  agent?: string;
  model?: ModelRef;
  system?: string;
} {
  if (input.visibility === "system") {
    return {
      ...(input.identity.agent ? { agent: input.identity.agent } : {}),
      ...(input.identity.model ? { model: input.identity.model } : {}),
      parts: [],
      system: input.prompt,
    };
  }

  return {
    ...(input.identity.agent ? { agent: input.identity.agent } : {}),
    ...(input.identity.model ? { model: input.identity.model } : {}),
    parts: [{ text: input.prompt, type: "text" }],
  };
}

export function renderWorkflowOutput(
  input: RenderWorkflowOutputInput,
): string {
  if (input.transcriptRequested) {
    return input.transcript;
  }

  const lastAssistant = latestAssistantMessage(input.assistantMessages);
  if (!lastAssistant) {
    throw new Error("No assistant reply was recorded for the completed command.");
  }
  return lastAssistant;
}
