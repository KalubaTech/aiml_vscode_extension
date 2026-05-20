/**
 * AIML API client.
 *
 * Talks to AIML's /v1/chat with the Anthropic-shaped tool-calling contract.
 * Runs the agentic loop locally: when the model emits `tool_use`, we execute
 * the declared client-side tools and feed `toolResults` back until the model
 * returns `stopReason: "end_turn"` (or we hit the max-step budget).
 */

import * as vscode from 'vscode';

export interface ToolDef {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface ToolUse {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface ChatResponse {
  conversationId: string;
  reply: string;
  handler: string;
  blocked: boolean;
  warnings: string[];
  appliedRuleIds: string[];
  ragSources: string[];
  toolCalls: ToolUse[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'rule_block';
  usage: { tokensIn: number; tokensOut: number; latencyMs: number; model: string | null };
}

export interface ToolExecutor {
  /**
   * Execute one tool call. Throw on unrecoverable error; return the string
   * result to feed back to the model (e.g. file contents, command output).
   */
  execute(call: ToolUse): Promise<{ content: string; isError?: boolean }>;
  /** Tool declarations to send with each request. */
  declarations(): ToolDef[];
}

export interface AgentUpdate {
  kind: 'assistant_text' | 'tool_use' | 'tool_result' | 'done' | 'error' | 'progress';
  text?: string;
  tool?: { name: string; input: unknown; id: string };
  result?: { id: string; content: string; isError?: boolean };
  response?: ChatResponse;
  error?: string;
  /** For `progress` updates: 1-based step counter. */
  step?: number;
  /** For `progress` updates: human label of what's happening this step. */
  stepLabel?: string;
  /** For `progress` updates: maximum steps allowed. */
  stepMax?: number;
}

export class AimlClient {
  constructor(
    private getConfig: () => {
      endpoint: string;
      apiKey: string;
      projectId: string;
      defaultModel: string;
      maxAgentSteps: number;
    },
  ) {}

  /** Fetch the catalogue of available models from the platform. */
  async listModels(): Promise<Array<{ id: string; name: string; description: string; default?: boolean }>> {
    const cfg = this.getConfig();
    if (!cfg.apiKey) return [];
    const url = cfg.endpoint.replace(/\/+$/, '') + '/v1/models';
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: Array<{ id: string; name: string; description: string; default?: boolean }> };
    return data.models ?? [];
  }

  /**
   * Run a chat turn through the agent loop. `onUpdate` is called for every
   * intermediate state — useful for streaming UX into the webview.
   */
  async chat(args: {
    message: string;
    conversationId: string | undefined;
    executor: ToolExecutor;
    onUpdate: (u: AgentUpdate) => void;
    userId?: string;
    extraSystemHints?: string; // unused server-side today, reserved
  }): Promise<{ conversationId: string; lastReply: string }> {
    const cfg = this.getConfig();
    if (!cfg.apiKey) throw new Error('AIML API key not configured. Run "AIML: Configure".');
    if (!cfg.projectId) throw new Error('AIML project ID not configured. Run "AIML: Configure".');

    const tools = executorDecl(args.executor);
    let conversationId = args.conversationId;
    let lastReply = '';

    // Step 0: initial user turn.
    let pending: { toolResults?: ToolResult[]; message?: string } = { message: args.message };

    for (let step = 0; step <= cfg.maxAgentSteps; step++) {
      args.onUpdate({
        kind: 'progress',
        step: step + 1,
        stepMax: cfg.maxAgentSteps,
        stepLabel: step === 0 ? 'sending message…' : 'thinking…',
      });

      const body: Record<string, unknown> = {
        projectId: cfg.projectId,
        tools,
      };
      if (conversationId) body.conversationId = conversationId;
      if (args.userId) body.userId = args.userId;
      // Forward the user-selected model. If unset, the server falls back to
      // the project's default model.
      if (cfg.defaultModel) body.model = cfg.defaultModel;
      if (pending.message) body.message = pending.message;
      if (pending.toolResults) body.toolResults = pending.toolResults;

      const resp = await this.postChat(body);
      conversationId = resp.conversationId;
      if (resp.reply) {
        lastReply = resp.reply;
        args.onUpdate({ kind: 'assistant_text', text: resp.reply, response: resp });
      }

      if (resp.stopReason !== 'tool_use' || resp.toolCalls.length === 0) {
        args.onUpdate({ kind: 'done', response: resp });
        return { conversationId, lastReply };
      }

      // Execute each tool call, collect results.
      const results: ToolResult[] = [];
      for (const call of resp.toolCalls) {
        args.onUpdate({ kind: 'tool_use', tool: { id: call.id, name: call.name, input: call.input } });
        try {
          const r = await args.executor.execute(call);
          results.push({ tool_use_id: call.id, content: r.content, is_error: r.isError });
          args.onUpdate({
            kind: 'tool_result',
            result: { id: call.id, content: r.content, isError: r.isError },
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push({ tool_use_id: call.id, content: `Error: ${msg}`, is_error: true });
          args.onUpdate({
            kind: 'tool_result',
            result: { id: call.id, content: `Error: ${msg}`, isError: true },
          });
        }
      }
      pending = { toolResults: results };
    }

    const msg = `Agent reached max step budget (${cfg.maxAgentSteps}). Stopping.`;
    args.onUpdate({ kind: 'error', error: msg });
    return { conversationId: conversationId ?? '', lastReply: lastReply || msg };
  }

  private async postChat(body: Record<string, unknown>): Promise<ChatResponse> {
    const cfg = this.getConfig();
    const url = cfg.endpoint.replace(/\/+$/, '') + '/v1/chat';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`AIML returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      const obj = parsed as { error?: string; message?: string } | null;
      const err = obj?.error || `HTTP ${res.status}`;
      const detail = obj?.message ? ` — ${obj.message}` : '';
      throw new Error(`${err}${detail}`);
    }
    return parsed as ChatResponse;
  }
}

function executorDecl(e: ToolExecutor): ToolDef[] {
  try {
    return e.declarations();
  } catch (err) {
    vscode.window.showErrorMessage(`AIML: failed to build tool declarations — ${(err as Error).message}`);
    return [];
  }
}
