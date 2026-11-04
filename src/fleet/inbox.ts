import { lstat, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FleetCommand } from './model';

/** Claim before dispatch. A crash leaves a receipt, never an automatic replay. */
export class FleetInbox {
  constructor(private readonly directory: string) {}

  private path(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('多电脑命令 ID 无效');
    return join(this.directory, `${id}.json`);
  }

  async claim(command: FleetCommand): Promise<boolean> {
    await mkdir(this.directory, { recursive: true });
    let handle;
    try {
      handle = await open(this.path(command.id), 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const existing = await lstat(this.path(command.id));
        if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('收件记录不是普通文件，未执行操作');
        return false;
      }
      throw error;
    }
    try {
      await handle.writeFile(JSON.stringify({ id: command.id, acceptedAt: Date.now(), state: 'accepted' }));
      await handle.sync();
    } finally { await handle.close(); }
    return true;
  }

  async finish(id: string, state: 'dispatched' | 'rejected' | 'unknown'): Promise<void> {
    const path = this.path(id);
    const previous = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ ...previous, state }), { mode: 0o600 });
    await rename(temporary, path);
  }
}
