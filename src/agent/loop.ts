import type { FunctionTool, ModelClient, ToolCall, WireMessage } from '../ollama/client';
import type { AgentStep, ModelInfo, ReasoningEffort } from '../shared/protocol';
import type { Checkpoint } from './checkpoint';
import { failureSite, linesAround } from './failureSite';
import { checksSyntax, syntaxProblem } from './syntax';
import { latestCopyNote, numberedCopy, retireCopies } from './fileViews';
import { describeProblems, newProblems, type Problem } from './instructions';
import { needsApproval } from './policy';
import { appStartIn, COMMAND_NOT_FOUND, MAX_VERIFY_ROUNDS, syntaxCheckCommand } from './verify';
import {
  applyWrite,
  COMMAND_TIMEOUT_MS,
  describeWrite,
  isWriteTool,
  keepEnds,
  MAX_COMMAND_OUTPUT_CHARS,
  cleanPath,
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
/** More steps for each failed check sent back, so the model can fix what it found. */
export const STEPS_PER_FIX = 6;
/** How much of a tool's arguments and result each step shows in the chat. */
export const MAX_STEP_DETAIL_CHARS = 2_000;

export const MALFORMED_TWICE =
  "The model sent tool calls it couldn't make twice in a row, so the task stopped. Try again, or pick a larger model.";
const REJECTED = 'The user rejected this. Do not try it again; ask what they want instead, or take another approach.';

/** Agent mode's sampling temperature: low, so small models (4B and smaller) keep to the tool format. */
export const AGENT_TEMPERATURE = 0.2;

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
  /** System prompt, earlier turns and the task, as sent to the model. Changed in place. */
  wire: WireMessage[];
  /** Index of the task in `wire`. */
  question: number;
  /** Shrinks `wire` to fit the context window; returns the task's new index. */
  fit(wire: WireMessage[], question: number, maxChars: number): number;
  /**
   * Summarizes the earlier conversation once the prompt is nearly full (src/chat/compact.ts),
   * with the model in use; returns the question's new index, or undefined if it didn't.
   */
  compact?(wire: WireMessage[], question: number, model: AgentModel): Promise<number | undefined>;
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
  /** A folder's own instruction files (AGENTS.md, CLAUDE.md) not given yet, for a path the agent works on. */
  instructionsFor?(path: string): Promise<string>;
  /** Errors VS Code's language support reports in a file; `wait` lets it re-check after a change first. */
  problems?(path: string, wait: boolean): Promise<Problem[]>;
  /** The project's check (build, typecheck or tests), run when the agent says it's done. */
  checkCommand?: string;
  /** How to start the app (`npm start`), run for a few seconds when it's done to see it works. */
  startCommand?: string;
  /** The app is a server: when started it must stay up and answer `/`. */
  startServes?: boolean;
  /** The `start` script's command line, to know it when the model runs it. */
  startScript?: string;
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
  /** The step limit: MAX_AGENT_STEPS, plus STEPS_PER_FIX for each failed check sent back. */
  let max = deps.maxSteps ?? MAX_AGENT_STEPS;
  const tools = [...deps.readTools, ...WRITE_TOOLS];
  const toolNames = new Set(tools.map((t) => t.function.name));
  const steps: AgentStep[] = [];
  const step = (s: AgentStep) => {
    steps.push(s);
    deps.onStep(s);
  };
  const current = deps.model;
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
  /** The same for starting the app. */
  const start = { asked: false, allowed: false };
  let changesAtCheck = -1;
  /** The failing lines of the latest failure that named one, for a rewrite that changed nothing. */
  const hint: Hint = {};
  /** Each file as the model last saw it whole or in part (read, or after its own edit). */
  const views = new Map<string, string>();

  let n = 1;
  /** The latest round's text, to tell whether the task ended mid-way at the step limit. */
  let lastText = '';
  for (; n <= max;) {
    const offered = n < max ? tools : undefined;
    const compacted = await deps.compact?.(deps.wire, question, current);
    if (deps.signal.aborted) throw abortError();
    if (compacted !== undefined) {
      question = compacted;
      // The copies the model had are summarized away: it reads a file again before editing it.
      views.clear();
      step({ title: 'Compacted the conversation to fit the context window', outcome: 'ok' });
    }
    question = deps.fit(deps.wire, question, current.info.maxPromptChars);
    let text = '';
    lastText = '';
    let calls: ToolCall[] | undefined;
    let thinking = false;
    for await (const event of current.client.streamChat(
      current.info.id,
      deps.wire,
      deps.signal,
      deps.effort,
      offered,
      AGENT_TEMPERATURE,
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
      const failure = await verifyWork(deps, baseline, step, check, start, hint);
      if (!failure) {
        unresolved = undefined;
        break;
      }
      if (verifyRounds >= MAX_VERIFY_ROUNDS || n > max) {
        unresolved = failure;
        break;
      }
      verifyRounds++;
      max += STEPS_PER_FIX;
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
          ? await runWrite(deps, call, step, baseline, progress, views, hint)
          : await runRead(deps, call, step, views);
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

async function runRead(
  deps: AgentDeps,
  call: ToolCall,
  step: (s: AgentStep) => void,
  seen: Map<string, string>,
): Promise<string> {
  const result = await deps.runRead(call);
  if (call.function.name === 'read_file' && !result.content.startsWith('Error')) {
    const read = cleanPath(pathOf(call) ?? '');
    try {
      seen.set(read, await deps.workspace.readFile(read));
    } catch {
      // Gone since: the next change to it finds out.
    }
  }
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
  start: { asked: boolean; allowed: boolean },
  hint: Hint,
): Promise<string | undefined> {
  const failures: string[] = [];
  // Every changed file must still parse, whatever VS Code has reported so far.
  const unparsed: string[] = [];
  for (const path of deps.checkpoint.files) {
    const broken = await syntaxNote(deps, path, hint);
    if (broken) {
      unparsed.push(path);
      failures.push(broken);
    }
  }
  if (unparsed.length) {
    step({ title: `Syntax error left in ${unparsed.join(', ')}`, outcome: 'error' });
  }
  if (deps.problems) {
    // Every error left in a file the task changed counts, not only new ones: a task that
    // changes a file should leave it working.
    let count = 0;
    let added = 0;
    for (const [path, before] of baseline) {
      const after = await deps.problems(path, false);
      if (!after.length) continue;
      count += after.length;
      added += newProblems(before, after).length;
      failures.push(describeProblems(path, before, after));
    }
    const files = `${baseline.size} changed file${baseline.size === 1 ? '' : 's'}`;
    step({
      title: count
        ? `Checked ${files}: ${count} error${count === 1 ? '' : 's'} left${added ? ` (${added} new)` : ''}`
        : `Checked ${files}: no errors`,
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
  // No project check, or you rejected it: at least parse the changed files. Parsing runs
  // no code, so no card.
  if (!deps.checkCommand || !check.allowed) {
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
    if (!passed) {
      failures.push(
        `The project check \`${deps.checkCommand}\` failed (${status}):\n${output}${await pointAt(deps, output, hint)}`,
      );
    }
  }
  // Code that parses and passes its checks can still crash when it runs: start the app
  // for a few seconds. It runs your code, so like the check it asks once per task.
  const smoke = deps.workspace.smokeRun?.bind(deps.workspace);
  if (!failures.length && deps.startCommand && smoke) {
    if (!start.asked) {
      start.asked = true;
      start.allowed = await deps.requestApproval({ kind: 'run_command', command: deps.startCommand });
      if (deps.signal.aborted) throw abortError();
      if (!start.allowed)
        step({ title: `Skipped starting the app with \`${deps.startCommand}\` (rejected)`, outcome: 'rejected' });
    }
    if (start.allowed) {
      const run = await smoke(deps.startCommand, deps.signal, deps.startServes ?? false);
      if (deps.signal.aborted) throw abortError();
      step({
        title: `Started the app with \`${deps.startCommand}\`: ${run.summary}`,
        detail: clip(run.output),
        outcome: run.ok ? 'ok' : 'error',
      });
      if (!run.ok)
        failures.push(
          `Starting the app with \`${deps.startCommand}\` failed: it ${run.summary}.\n${run.output}${await pointAt(deps, run.output, hint)}`,
        );
    }
  }
  return failures.length ? failures.join('\n\n') : undefined;
}

async function runWrite(
  deps: AgentDeps,
  call: ToolCall,
  step: (s: AgentStep) => void,
  baseline: Map<string, Problem[]>,
  progress: { changes: number; commands: number },
  seen: Map<string, string>,
  hint: Hint,
): Promise<string> {
  // Line numbers and whole-file rewrites only make sense against the file as it is now:
  // one that changed since the model saw it (a command, or you) is shown again first.
  const stale = await staleView(deps, call, seen);
  if (stale) {
    step({
      title: `Couldn't ${call.function.name.replace('_', ' ')} ${pathOf(call)}`,
      detail: stale,
      outcome: 'error',
    });
    return stale;
  }
  // A command that starts the app would block until stopped, or leave a server nobody
  // can reach: run it the way the run check does, for a few seconds, and say what happened.
  const smoke = deps.workspace.smokeRun?.bind(deps.workspace);
  const appStart =
    smoke && call.function.name === 'run_command' ? appStartIn(commandOf(call), deps.startScript) : undefined;
  const prepared = await prepareWrite(
    deps.workspace,
    appStart ? { ...call, function: { ...call.function, arguments: JSON.stringify({ command: appStart }) } } : call,
  );
  if ('error' in prepared) {
    // A rewrite that changes nothing means the model can't see what's wrong: show it again.
    if (prepared.error.includes('nothing changed') && hint.site) {
      prepared.error += await showSite(deps, hint.site.path, hint.site.line);
    }
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
    if (appStart && smoke) {
      const run = await smoke(appStart, deps.signal, deps.startServes ?? false);
      result = `${run.ok ? '' : 'Error: '}Started \`${appStart}\` for a few seconds, then stopped it: it ${run.summary}.\n${run.output}`;
      if (!run.ok) result += await pointAt(deps, run.output, hint);
    } else {
      result = await applyWrite(deps.workspace, pending, deps.signal, (e) => deps.checkpoint.remember(e));
    }
  } catch (err) {
    result = `Error: ${(err as Error).message}`;
  }
  if (deps.signal.aborted) throw abortError();
  if (pending.kind === 'run_command') {
    progress.commands++;
    if (!appStart && !/^Exit code 0\./.test(result)) result += await pointAt(deps, result, hint);
  }
  if (path && !result.startsWith('Error')) {
    progress.changes++;
    // A syntax error found here is certain and immediate; VS Code's list can lag behind
    // the edit and say "no errors" about a broken file, so then it's left out.
    const broken = await syntaxNote(deps, path, hint);
    if (broken) result += `\n${broken}`;
    else if (deps.problems) {
      result += `\n${describeProblems(path, baseline.get(path) ?? [], await deps.problems(path, true))}`;
    }
    // The model goes on from this copy, never an earlier one.
    const now = await deps.workspace.readFile(path).catch(() => undefined);
    if (now !== undefined) {
      seen.set(path, now);
      retireCopies(deps.wire, path, numberedCopy(path, now) !== undefined);
      result += latestCopyNote(path, now);
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

/** The command line of a run_command call, or "" if its arguments don't parse. */
function commandOf(call: ToolCall): string {
  try {
    const { command } = JSON.parse(call.function.arguments || '{}') as { command?: unknown };
    return typeof command === 'string' ? command : '';
  } catch {
    return '';
  }
}

/**
 * For replace_lines and write_file: an error with the file's latest copy if the file
 * changed since the model last saw it (a command or you changed it); undefined otherwise.
 */
async function staleView(deps: AgentDeps, call: ToolCall, seen: Map<string, string>): Promise<string | undefined> {
  if (call.function.name !== 'replace_lines' && call.function.name !== 'write_file') return undefined;
  const path = cleanPath(pathOf(call) ?? '');
  if (!path) return undefined;
  let now: string;
  try {
    now = await deps.workspace.readFile(path);
  } catch {
    return undefined; // Missing or unreadable: the tool itself says so.
  }
  const before = seen.get(path);
  if (before === undefined || before === now) return undefined;
  seen.set(path, now);
  const why = `${path} changed since you last saw it`;
  const copy = numberedCopy(path, now);
  return copy
    ? `Error: ${why}, so your line numbers or text may not match it. Nothing was changed. Here is its latest copy; make the change against it:\n${copy}`
    : `Error: ${why}. Nothing was changed. Read it with read_file, then make the change against what you read.`;
}

/**
 * The file's syntax error, with its numbered lines, if it doesn't parse
 * (`src/agent/syntax.ts`); "" if it does, or isn't a kind that's checked.
 */
async function syntaxNote(deps: AgentDeps, path: string, hint: Hint): Promise<string> {
  if (!checksSyntax(path)) return '';
  try {
    if (!(await deps.workspace.exists(path))) return '';
    const text = await deps.workspace.readFile(path);
    const problem = syntaxProblem(path, text);
    if (!problem) return '';
    hint.site = { path, line: problem.line };
    return `Syntax error in ${path} at line ${problem.line}: ${problem.message}. Fix it before going on.\n${linesAround(path, text, problem.line)}`;
  } catch {
    return '';
  }
}

/** The latest failure's place in the repository's code, for a rewrite that then changes nothing. */
interface Hint {
  site?: { path: string; line: number };
}

/**
 * The numbered lines where `output` says the code failed, if it names a line of a file
 * in the repository (`src/agent/failureSite.ts`), else "". Remembered in `hint`.
 */
async function pointAt(deps: AgentDeps, output: string, hint: Hint): Promise<string> {
  try {
    const site = failureSite(output, await deps.workspace.listFiles());
    if (!site) return '';
    hint.site = site;
    return await showSite(deps, site.path, site.line);
  } catch {
    return '';
  }
}

/** The file's lines around `line` as it is now, or "" if it can't be read. */
async function showSite(deps: AgentDeps, path: string, line: number): Promise<string> {
  try {
    return `\n\n${linesAround(path, await deps.workspace.readFile(path), line)}`;
  } catch {
    return '';
  }
}
