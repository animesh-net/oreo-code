import type { BeforeWrite, WritableWorkspace } from './writeTools';

/** What "Undo task" did: files put back, files left alone because they changed since, and failures. */
export interface RestoreResult {
  restored: string[];
  /** Changed after the task wrote them (by you or a command), so undo left them as they are. */
  changed: string[];
  failed: string[];
}

/**
 * What an agent task changed, so "Undo task" can put it back: each file's text from
 * before the task first touched it, and the text the task last left in it, kept in
 * memory. A file the task created is deleted on undo. A file that changed after the
 * task wrote it is left alone, so undo never overwrites later work. Commands' side
 * effects are not undone.
 */
export class Checkpoint {
  private readonly originals = new Map<string, string | undefined>();
  private readonly lastWritten = new Map<string, string>();

  /** `onFirstChange` runs when the task first changes a file. */
  constructor(private readonly onFirstChange?: () => void) {}

  /** Remembers a file's first state, and the latest text the task writes to it. */
  remember(entry: BeforeWrite): void {
    if (this.originals.size === 0) this.onFirstChange?.();
    if (!this.originals.has(entry.path)) this.originals.set(entry.path, entry.before);
    this.lastWritten.set(entry.path, entry.after);
  }

  get files(): string[] {
    return [...this.originals.keys()];
  }

  get isEmpty(): boolean {
    return this.originals.size === 0;
  }

  /** Puts back every file the task left as it wrote it. */
  async restore(ws: WritableWorkspace): Promise<RestoreResult> {
    const result: RestoreResult = { restored: [], changed: [], failed: [] };
    for (const [path, before] of [...this.originals].reverse()) {
      try {
        const now = (await ws.exists(path)) ? await ws.readFile(path) : undefined;
        if (now === undefined && before === undefined) {
          result.restored.push(path); // Created, and already gone.
          continue;
        }
        if (now !== this.lastWritten.get(path)) {
          result.changed.push(path);
          continue;
        }
        if (before === undefined) await ws.deleteFile(path);
        else await ws.writeFile(path, before);
        result.restored.push(path);
      } catch {
        result.failed.push(path);
      }
    }
    this.originals.clear();
    this.lastWritten.clear();
    return result;
  }
}
