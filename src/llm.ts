import { createHash } from "node:crypto";

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface JsonTask {
  task: string;
  promptVersion: string;
  schemaName: string;
  schema: Record<string, unknown>;
  system: string;
  user: string;
  maxTokens?: number;
}

export interface JsonTaskResult {
  content: string;
  inputHash: string;
}

export class OpenAICompatibleJsonClient {
  constructor(readonly options: OpenAICompatibleOptions) {}

  async complete(task: JsonTask): Promise<JsonTaskResult> {
    const inputHash = createHash("sha256").update(`${task.task}\0${task.promptVersion}\0${task.system}\0${task.user}`).digest("hex");
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiKey}` },
      body: JSON.stringify({
        model: this.options.model,
        temperature: 0,
        max_tokens: task.maxTokens ?? 2048,
        response_format: {
          type: "json_schema",
          json_schema: { name: task.schemaName, strict: true, schema: task.schema },
        },
        messages: [
          { role: "system", content: task.system },
          { role: "user", content: task.user },
        ],
      }),
    });
    if (!response.ok) throw new Error(`${task.task} LLM request failed: ${response.status} ${await response.text()}`);
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return { content: body.choices?.[0]?.message?.content ?? "", inputHash };
  }
}

export function parseJsonObject(content: string): Record<string, unknown> {
  const cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Model response did not contain a JSON object");
  const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Model response was not a JSON object");
  return parsed as Record<string, unknown>;
}
