import type { FunctionTool, ModelClient, ToolCall, WireMessage } from '../ollama/client';
import type { AgentStep, ModelInfo, ReasoningEffort } from '../shared/protocol';
import type { Checkpoint } from './checkpoint';
import { needsApproval } from './policy';
import { applyWrite, describeWrite, isWriteTool, prepareWrite, WRITE_TOOLS, type PendingWrite } from './writeTools';
import type { ToolResult } from './workspaceTools';
import type { WritableWorkspace } from './writeTools';

/**
 * Model calls per agent task. Each call may use tools; the last one gets none, so the
 * model has to say what it did. Kept here only.
 */
export const MAX_AGENT_STEPS = 15;
/** How much of a tool's arguments and result each step shows in the chat. */
export const MAX_STEP_DETAIL_CHARS = 2_000;

export const MALFORMED_TWICE =
  "The model sent tool calls it couldn't make twice in a row, so the task stopped. Try again, or pick a larger model.";
const REJECTED = 'The user rejected this. Do not try it again; ask what they want instead, or take another approach.';

export interface AgentModel {
  client: ModelClient;
  info: ModelInfo;
}

export interface AgentDeps {
  model: AgentModel;
  /** A Mac model to move to if Cloudflare's limits stop a cloud model mid-task. */
  fallback?: AgentModel;
  /** True when an error is Cloudflare's daily allowance or rate limit. */
  isCloudLimit(err: unknown): boolean;
  /** System prompt, earlier turns and the task, as sent to the model. Changed in place. */
  wire: WireMessage[];
  /** Index of the task in `wire`. */
  question: number;
  /** Shrinks `wire` to fit the context window; returns the task's new index. */
  fit(wire: WireMessage[], question: number, maxChars: number): number;
  effort: ReasoningEffort;
  signal: AbortSignal;
  /** Read-only tools (list, read, search, find_symbol) and how to run them. */
  readTools: FunctionTool[];
  runRead(call: ToolCall): Promise<ToolResult>;
  workspace: WritableWorkspace;
  /** "Approve edits for this task", read at each write so a change mid-task counts. */
  approveEdits(): boolean;
  /** Shows the approval card; resolves false on Reject or Stop. */
  requestApproval(pending: PendingWrite): Promise<boolean>;
  checkpoint: Checkpoint;
  onText(delta: string): void;
  onThinking(): void;
  onStep(step: AgentStep): void;
  /** Called when the task moves to the fallback model, so errors after it are worded for that model. */
  onMove?(model: ModelInfo): void;
  maxSteps?: number;
}

export interface AgentResult {
  reply: string;
  steps: AgentStep[];
  /** The model that finished the task (differs after a move to the Mac). */
  model: ModelInfo;
}

/**
 * Runs one agent task: the model plans, calls tools, reads the results and goes on
 * until it answers without tools or the step limit is reached. Every write goes
 * through needsApproval() here, in code, whatever the model was told. Throws on
 * failure; on Stop the caller sees the abort.
 */
export async function runAgent(deps: AgentDeps): Promise<AgentResult> {
  const max = deps.maxSteps ?? MAX_AGENT_STEPS;
  const tools = [...deps.readTools, ...WRITE_TOOLS];
  const toolNames = new Set(tools.map((t) => t.function.name));
  const steps: AgentStep[] = [];
  const step = (s: AgentStep) => {
    steps.push(s);
    deps.onStep(s);
  };
  let current = deps.model;
  let moved = false;
  let question = deps.question;
  let reply = '';
  let malformedRounds = 0;

  for (let n = 1; n <= max;) {
    const offered = n < max ? tools : undefined;
    question = deps.fit(deps.wire, question, current.info.maxPromptChars);
    let text = '';
    let calls: ToolCall[] | undefined;
    let thinking = false;
    try {
      for await (const event of current.client.streamChat(
        current.info.id,
        deps.wire,
        deps.signal,
        deps.effort,
        offered,
      )) {
        if (event.type === 'toolCalls') {
          calls = event.calls;
        } else if (event.type === 'thinking') {
          if (!thinking) deps.onThinking();
          thinking = true;
        } else {
          const delta = !text && reply ? `\n\n${event.text}` : event.text;
          text += event.text;
          reply += delta;
          deps.onText(delta);
        }
      }
    } catch (err) {
      const canMove =
        !moved && !text && deps.fallback && current.info.provider === 'cloudflare' && deps.isCloudLimit(err);
      if (deps.signal.aborted || !canMove || !deps.fallback) throw err;
      moved = true;
      current = deps.fallback;
      deps.onMove?.(current.info);
      step({
        title: `Cloudflare's limit is reached; moved to ${current.info.name} on the Mac`,
        outcome: 'error',
      });
      continue; // Same step again, on the Mac.
    }
    n++;
    if (!calls?.length) break;

    deps.wire.push({ role: 'assistant', content: text, tool_calls: calls });
    let malformed = false;
    for (const call of calls) {
      if (deps.signal.aborted) throw abortError();
      const problem = malformedProblem(call, toolNames);
      if (problem) {
        malformed = true;
        step({ title: `Couldn't use ${call.function.name || 'a tool'}`, detail: problem, outcome: 'error' });
        deps.wire.push({ role: 'tool', tool_call_id: call.id, content: problem });
        continue;
      }
      const result = isWriteTool(call.function.name)
        ? await runWrite(deps, call, step)
        : await runRead(deps, call, step);
      deps.wire.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
    if (malformed) {
      malformedRounds++;
      if (malformedRounds >= 2) throw new Error(MALFORMED_TWICE);
    } else {
      malformedRounds = 0;
    }
  }

  // A model sometimes ends after tools with nothing to say. Ask once for a summary.
  if (!reply.trim() && !deps.signal.aborted) {
    deps.wire.push({ role: 'user', content: 'Say briefly what you did and what is left, if anything.' });
    deps.fit(deps.wire, question, current.info.maxPromptChars);
    try {
      for await (const event of current.client.streamChat(current.info.id, deps.wire, deps.signal, 'none')) {
        if (event.type !== 'text') continue;
        reply += event.text;
        deps.onText(event.text);
      }
    } catch (err) {
      // The work is done; a failed summary only loses the summary, unless you pressed Stop.
      if (deps.signal.aborted) throw err;
    }
  }
  if (!reply.trim()) {
    reply = steps.length
      ? `Finished after ${steps.length} tool call${steps.length === 1 ? '' : 's'}.`
      : 'Finished without an answer.';
    deps.onText(reply);
  }
  return { reply, steps, model: current.info };
}

async function runRead(deps: AgentDeps, call: ToolCall, step: (s: AgentStep) => void): Promise<string> {
  const result = await deps.runRead(call);
  step({
    title: result.summary,
    detail: detail(call, result.content),
    outcome: result.content.startsWith('Error') ? 'error' : 'ok',
  });
  return result.content;
}

async function runWrite(deps: AgentDeps, call: ToolCall, step: (s: AgentStep) => void): Promise<string> {
  const prepared = await prepareWrite(deps.workspace, call);
  if ('error' in prepared) {
    step({ title: `Couldn't ${call.function.name.replace('_', ' ')}`, detail: prepared.error, outcome: 'error' });
    return prepared.error;
  }
  const { pending } = prepared;
  const title = describeWrite(pending);
  if (needsApproval(pending.kind, deps.approveEdits())) {
    const approved = await deps.requestApproval(pending);
    if (deps.signal.aborted) throw abortError();
    if (!approved) {
      step({ title: `${title} (rejected)`, outcome: 'rejected' });
      return REJECTED;
    }
  }
  let result: string;
  try {
    result = await applyWrite(deps.workspace, pending, deps.signal, (e) => deps.checkpoint.remember(e));
  } catch (err) {
    result = `Error: ${(err as Error).message}`;
  }
  if (deps.signal.aborted) throw abortError();
  const shown = pending.kind === 'run_command' ? result : 'diff' in pending ? `${pending.diff}\n\n${result}` : result;
  step({ title, detail: clip(shown), outcome: result.startsWith('Error') ? 'error' : 'ok' });
  return result;
}

/** A call the model can't have meant: an unknown tool or arguments that aren't a JSON object. */
export function malformedProblem(call: ToolCall, toolNames: ReadonlySet<string>): string | undefined {
  if (!toolNames.has(call.function.name)) {
    return `Error: there is no tool "${call.function.name}". Use one of: ${[...toolNames].join(', ')}.`;
  }
  try {
    const args: unknown = JSON.parse(call.function.arguments || '{}');
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return 'Error: arguments must be a JSON object.';
    }
  } catch {
    return 'Error: arguments were not valid JSON. Send them as a JSON object.';
  }
  return undefined;
}

function detail(call: ToolCall, result: string): string {
  return clip(`${call.function.arguments || '{}'}\n\n${result}`);
}

function clip(text: string): string {
  return text.length > MAX_STEP_DETAIL_CHARS ? `${text.slice(0, MAX_STEP_DETAIL_CHARS)}\n… (cut)` : text;
}

function abortError(): Error {
  const err = new Error('Stopped.');
  err.name = 'AbortError';
  return err;
}
