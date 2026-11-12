import type { FunctionTool, ModelClient, ToolCall, WireMessage } from '../ollama/client';
import type { AgentStep, ModelInfo, ReasoningEffort } from '../shared/protocol';
import type { Checkpoint } from './checkpoint';
import { describeProblems, newProblems, type Problem } from './instructions';
import { needsApproval } from './policy';
import { COMMAND_NOT_FOUND, MAX_VERIFY_ROUNDS, syntaxCheckCommand } from './verify';
import {
  applyWrite,
  COMMAND_TIMEOUT_MS,
  describeWrite,
  isWriteTool,
  keepEnds,
  MAX_COMMAND_OUTPUT_CHARS,
  prepareWrite,
  WRITE_TOOLS,
  type PendingWrite,
} from './writeTools';
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

/** How many times a task may be told to carry out what it announced. */
export const MAX_NUDGES = 3;
const GO_ON =
  "You said what you'll do but didn't do it. Do it now with the tools (edit_file, create_file, run_command). When the whole task is done, say so in a few lines.";

/**
 * True when a reply ends by announcing a next step rather than finishing: "I'll…",
 * "Let me…", "Next, I…", or a closing colon. A question to the user is an answer.
 */
export function announcesAction(text: string): boolean {
  const end = text.trim().slice(-400);
  if (!end || end.endsWith('?')) return false;
  if (end.endsWith(':')) return true;
  const last = end
    .split(/(?<=[.!])\s+/)
    .slice(-2)
    .join(' ');
  return /\b(i'?ll|i will|let me|let's|i'?m going to|i am going to|next,? i|now i'?ll|i'?ll now|i need to|i should now)\b/i.test(
    last,
  );
}

const NOT_CHANGED =
  'Your reply says files were changed, but no file has been changed in this task: describing a fix does not make it. If the task needs changes, make them now with edit_file or create_file. If you meant changes from an earlier task, or none are needed, say that instead.';

const CLAIM =
  /\b(files? (changed|modified|updated)|changes? (made|applied)|i('ve| have)? (now )?(fixed|updated|changed|modified|edited|rewritten|rewrote|removed|added|created|replaced|refactored)|(has|have) been (fixed|updated|changed|modified|rewritten|removed|added|created))\b/gi;
/** Words just before a claim that turn it around: "no files changed", "nothing has been fixed". */
const NEGATED = /\b(no|not|nothing|never|none|n't|without)\b[\s\w]{0,12}$/i;
/** A claim about another time ("in the last task I fixed…", "earlier I updated…"). */
const ELSEWHEN = /\b(earlier|before|previously|last (task|time)|in the (last|previous) task)\b/i;

/**
 * True when a reply says files were changed ("Files changed:", "I fixed…", "…has been
 * updated"), not negated and not about an earlier task. Checked only when the task
 * changed no file and ran no command, so a claim there is a mistake.
 */
export function claimsChanges(text: string): boolean {
  for (const m of text.matchAll(CLAIM)) {
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (!NEGATED.test(before) && !ELSEWHEN.test(sentenceAround(text, m.index, m.index + m[0].length))) return true;
  }
  return false;
}

/** A sentence ends at . ! or ? followed by a space or the end, or at a line break; "index.js" doesn't end one. */
const SENTENCE_END = /[.!?](?=\s|$)|\n/g;

/** The sentence holding text[from..to]. */
function sentenceAround(text: string, from: number, to: number): string {
  let start = 0;
  let end = text.length;
  for (const m of text.matchAll(SENTENCE_END)) {
    if (m.index < from) start = m.index + 1;
    else if (m.index >= to) {
      end = m.index;
      break;
    }
  }
  return text.slice(start, end);
}

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
  /** "Apply edits without asking", read at each write so a change mid-task counts. */
  approveEdits(): boolean;
  /** Shows the approval card; resolves false on Reject or Stop. */
  requestApproval(pending: PendingWrite): Promise<boolean>;
  checkpoint: Checkpoint;
  onText(delta: string): void;
  onThinking(): void;
  onStep(step: AgentStep): void;
  /** Called when the task moves to the fallback model, so errors after it are worded for that model. */
  onMove?(model: ModelInfo): void;
  /** A folder's own instruction files (AGENTS.md, CLAUDE.md) not given yet, for a path the agent works on. */
  instructionsFor?(path: string): Promise<string>;
  /** Errors VS Code's language support reports in a file; `wait` lets it re-check after a change first. */
  problems?(path: string, wait: boolean): Promise<Problem[]>;
  /** The project's check (build, typecheck or tests), run when the agent says it's done. */
  checkCommand?: string;
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
  /** Each changed file's errors before the task touched it. */
  const baseline = new Map<string, Problem[]>();
  let verifyRounds = 0;
  let nudges = 0;
  /** The last reply claimed changes, but the task changed no file. */
  let unchangedClaim = false;
  let claimAsked = false;
  let unresolved: string | undefined;
  /** Files changed so far, and how many had changed at the last check. */
  const progress = { changes: 0, commands: 0 };
  /** Whether you were asked to allow the project check this task, and the answer. */
  const check = { asked: false, allowed: false };
  let changesAtCheck = -1;

  let n = 1;
  /** The latest round's text, to tell whether the task ended mid-way at the step limit. */
  let lastText = '';
  for (; n <= max;) {
    const offered = n < max ? tools : undefined;
    question = deps.fit(deps.wire, question, current.info.maxPromptChars);
    let text = '';
    lastText = '';
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
    lastText = text;
    // The last round offers no tools; a call the model makes anyway isn't run.
    if (!offered) calls = undefined;
    if (!calls?.length) {
      // Small models often say what they'll do next ("I'll remove the duplicate…") and
      // stop without calling a tool. That isn't an answer: tell it to go on.
      if (offered && nudges < MAX_NUDGES && announcesAction(text)) {
        nudges++;
        deps.wire.push({ role: 'assistant', content: text });
        deps.wire.push({ role: 'user', content: GO_ON });
        continue;
      }
      // Or it says it changed files when this task changed none and ran no command (which
      // could have changed files): the change never happened. Asked once; a wrong guess
      // costs one extra model call.
      if (deps.checkpoint.isEmpty && progress.commands === 0 && claimsChanges(text)) {
        if (offered && !claimAsked) {
          claimAsked = true;
          deps.wire.push({ role: 'assistant', content: text });
          deps.wire.push({ role: 'user', content: NOT_CHANGED });
          continue;
        }
        unchangedClaim = true;
      }
      // Done, says the model. A task that changed files ends only with working code:
      // no new errors and a passing project check, or the failure goes back to fix.
      if (deps.checkpoint.isEmpty) break;
      // The model answered a failed check without changing anything: it judged the
      // failure not its own (e.g. already broken before the task). Report it and stop.
      if (progress.changes === changesAtCheck) break;
      changesAtCheck = progress.changes;
      const failure = await verifyWork(deps, baseline, step, check);
      if (!failure) {
        unresolved = undefined;
        break;
      }
      if (verifyRounds >= MAX_VERIFY_ROUNDS || n > max) {
        unresolved = failure;
        break;
      }
      verifyRounds++;
      unresolved = failure;
      deps.wire.push({ role: 'assistant', content: text });
      deps.wire.push({
        role: 'user',
        content: `Not done yet: the code must work before the task ends.\n\n${failure}\n\nFix what your changes caused, then say briefly what you changed. If a failure was there before your changes and isn't caused by them, don't change unrelated code: say so and stop.`,
      });
      continue;
    }

    // Every call needs a unique id for its result to point at; some models leave it out.
    const seen = new Set<string>();
    calls.forEach((call, i) => {
      if (!call.id || seen.has(call.id)) call.id = `call_${n}_${i}`;
      seen.add(call.id);
    });
    deps.wire.push({ role: 'assistant', content: text, tool_calls: calls });
    let malformed = false;
    for (const call of calls) {
      if (deps.signal.aborted) throw abortError();
      const problem = malformedProblem(call, toolNames);
      if (problem) {
        malformed = true;
        // Ollama rejects a conversation that carries arguments it can't parse, which
        // would fail the retry; the error result tells the model what went wrong.
        if (!isJsonObject(call.function.arguments)) call.function.arguments = '{}';
        step({ title: `Couldn't use ${call.function.name || 'a tool'}`, detail: problem, outcome: 'error' });
        deps.wire.push({ role: 'tool', tool_call_id: call.id, content: problem });
        continue;
      }
      let result: string;
      try {
        result = isWriteTool(call.function.name)
          ? await runWrite(deps, call, step, baseline, progress)
          : await runRead(deps, call, step);
      } catch (err) {
        if (deps.signal.aborted) throw err;
        // A tool that fails tells the model, which can try another way; the task goes on.
        result = `Error: ${(err as Error).message}`;
        step({ title: `${call.function.name} failed`, detail: result, outcome: 'error' });
      }
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
  if (unchangedClaim && deps.checkpoint.isEmpty) {
    const note = "\n\nNote: this task didn't change any file.";
    reply += note;
    deps.onText(note);
  }
  if (n > max && (!lastText.trim() || announcesAction(lastText))) {
    const note = `\n\nStopped at the ${max}-step limit before finishing. Send "continue" to go on.`;
    reply += note;
    deps.onText(note);
  }
  if (unresolved) {
    const note = `\n\nThe checks still fail, so this isn't working yet:\n\n${unresolved}`;
    reply += note;
    deps.onText(note);
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
  const path = call.function.name === 'read_file' ? pathOf(call) : undefined;
  return path && !result.content.startsWith('Error') ? withInstructions(deps, path, result.content) : result.content;
}

/** Adds the instructions of the folders above `path` that the model hasn't had yet. */
async function withInstructions(deps: AgentDeps, path: string, result: string): Promise<string> {
  const extra = (await deps.instructionsFor?.(path)) ?? '';
  return extra ? `${result}\n\nInstructions for this part of the repository; follow them:\n${extra}` : result;
}

function pathOf(call: ToolCall): string | undefined {
  try {
    const path = (JSON.parse(call.function.arguments || '{}') as { path?: unknown }).path;
    return typeof path === 'string' ? path.trim().replace(/^\.\//, '') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * When the agent says it's done: the errors its changes added, then the project's
 * check. Returns what failed, for the model to fix, or undefined if all is well.
 */
async function verifyWork(
  deps: AgentDeps,
  baseline: ReadonlyMap<string, Problem[]>,
  step: (s: AgentStep) => void,
  check: { asked: boolean; allowed: boolean },
): Promise<string | undefined> {
  const failures: string[] = [];
  if (deps.problems) {
    let count = 0;
    for (const [path, before] of baseline) {
      const after = await deps.problems(path, false);
      const added = newProblems(before, after);
      if (added.length) {
        count += added.length;
        failures.push(describeProblems(path, before, after));
      }
    }
    step({
      title: `Checked ${baseline.size} changed file${baseline.size === 1 ? '' : 's'}: ${count ? `${count} new error${count === 1 ? '' : 's'}` : 'no new errors'}`,
      outcome: count ? 'error' : 'ok',
    });
  }
  // The check runs the project's code, which the agent may have just changed, so it
  // asks once per task before the first run; after that it runs on its own.
  if (deps.checkCommand && !check.asked) {
    check.asked = true;
    check.allowed = await deps.requestApproval({ kind: 'run_command', command: deps.checkCommand });
    if (deps.signal.aborted) throw abortError();
    if (!check.allowed) {
      step({ title: `Skipped the project check \`${deps.checkCommand}\` (rejected)`, outcome: 'rejected' });
    }
  }
  // No project check: at least parse the changed files. Parsing runs no code, so no card.
  if (!deps.checkCommand) {
    const syntax = syntaxCheckCommand([...baseline.keys(), ...deps.checkpoint.files].filter(unique));
    if (syntax) {
      const result = await deps.workspace.runCommand(syntax, deps.signal);
      if (deps.signal.aborted) throw abortError();
      const missing = result.exitCode === COMMAND_NOT_FOUND;
      const passed = missing || (!result.timedOut && result.exitCode === 0);
      const output = keepEnds(result.output.trim(), MAX_COMMAND_OUTPUT_CHARS) || '(no output)';
      step({
        title: missing
          ? 'Skipped the Python syntax check: python3 is not installed'
          : `Checked the syntax of the changed Python files: ${passed ? 'passed' : 'failed'}`,
        detail: clip(output),
        outcome: passed ? 'ok' : 'error',
      });
      if (!passed) {
        failures.push(
          `Python couldn't parse a changed file:\n${output}\nIf this is valid syntax that this Python version doesn't know, say so instead of changing it.`,
        );
      }
    }
  }
  if (deps.checkCommand && check.allowed) {
    const result = await deps.workspace.runCommand(deps.checkCommand, deps.signal);
    if (deps.signal.aborted) throw abortError();
    const passed = !result.timedOut && result.exitCode === 0;
    const status = result.timedOut
      ? `stopped after ${COMMAND_TIMEOUT_MS / 1000} seconds`
      : result.exitCode === undefined
        ? 'stopped'
        : `exit code ${result.exitCode}`;
    const output = keepEnds(result.output.trim(), MAX_COMMAND_OUTPUT_CHARS) || '(no output)';
    step({
      title: `Ran the project check \`${deps.checkCommand}\`: ${passed ? 'passed' : 'failed'}`,
      detail: clip(output),
      outcome: passed ? 'ok' : 'error',
    });
    if (!passed) failures.push(`The project check \`${deps.checkCommand}\` failed (${status}):\n${output}`);
  }
  return failures.length ? failures.join('\n\n') : undefined;
}

async function runWrite(
  deps: AgentDeps,
  call: ToolCall,
  step: (s: AgentStep) => void,
  baseline: Map<string, Problem[]>,
  progress: { changes: number; commands: number },
): Promise<string> {
  const prepared = await prepareWrite(deps.workspace, call);
  if ('error' in prepared) {
    const where = pathOf(call);
    step({
      title: `Couldn't ${call.function.name.replace('_', ' ')}${where ? ` ${where}` : ''}`,
      detail: prepared.error,
      outcome: 'error',
    });
    return prepared.error;
  }
  const { pending } = prepared;
  const title = describeWrite(pending);
  if (needsApproval(pending.kind, deps.approveEdits(), 'path' in pending ? pending.path : undefined)) {
    const approved = await deps.requestApproval(pending);
    if (deps.signal.aborted) throw abortError();
    if (!approved) {
      step({ title: `${title} (rejected)`, outcome: 'rejected' });
      return REJECTED;
    }
  }
  const path = pending.kind === 'run_command' ? undefined : pending.path;
  // Errors already in the file before the task touched it aren't the agent's to fix. A
  // file nobody has opened has no errors listed yet, so let its language support look first.
  if (path && deps.problems && !baseline.has(path)) {
    baseline.set(path, pending.kind === 'create_file' ? [] : await deps.problems(path, true));
  }
  let result: string;
  try {
    result = await applyWrite(deps.workspace, pending, deps.signal, (e) => deps.checkpoint.remember(e));
  } catch (err) {
    result = `Error: ${(err as Error).message}`;
  }
  if (deps.signal.aborted) throw abortError();
  if (pending.kind === 'run_command') progress.commands++;
  if (path && !result.startsWith('Error')) {
    progress.changes++;
    if (deps.problems) {
      result += `\n${describeProblems(path, baseline.get(path) ?? [], await deps.problems(path, true))}`;
    }
    result = await withInstructions(deps, path, result);
  }
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

const unique = (v: string, i: number, all: string[]) => all.indexOf(v) === i;

function isJsonObject(text: string): boolean {
  try {
    const v: unknown = JSON.parse(text || '{}');
    return !!v && typeof v === 'object' && !Array.isArray(v);
  } catch {
    return false;
  }
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
