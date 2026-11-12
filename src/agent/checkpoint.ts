import type { BeforeWrite, WritableWorkspace } from './writeTools';

/**
 * What an agent task changed, so "Undo task" can put it back: each file's text from
 * before the task first touched it, kept in memory. A file the task created is
 * deleted on undo. Commands' side effects are not undone.
 */
export class Checkpoint {
  private readonly originals = new Map<string, string | undefined>();

  /** Remembers a file's first state only; later edits in the same task keep it. */
  remember(entry: BeforeWrite): void {
    if (!this.originals.has(entry.path)) this.originals.set(entry.path, entry.before);
  }

  get files(): string[] {
    return [...this.originals.keys()];
  }

  get isEmpty(): boolean {
    return this.originals.size === 0;
  }

  /** Puts every file back as it was. Returns the paths it couldn't restore. */
  async restore(ws: WritableWorkspace): Promise<string[]> {
    const failed: string[] = [];
    for (const [path, before] of [...this.originals].reverse()) {
      try {
        if (before === undefined) {
          if (await ws.exists(path)) await ws.deleteFile(path);
        } else {
          await ws.writeFile(path, before);
        }
      } catch {
        failed.push(path);
      }
    }
    this.originals.clear();
    return failed;
  }
}
