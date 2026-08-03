import { open, stat } from 'node:fs/promises';
import path from 'node:path';

export type DashboardLogStream = 'stdout' | 'stderr';

export interface DashboardLogEntry {
  stream: DashboardLogStream;
  text: string;
  timestamp: number | null;
  level: string | null;
}

export interface DashboardLogCursor {
  stdout: number;
  stderr: number;
}

export interface DashboardLogBatch {
  entries: DashboardLogEntry[];
  cursor: DashboardLogCursor;
  truncated: boolean;
}

interface ReadResult {
  entries: DashboardLogEntry[];
  cursor: number;
  truncated: boolean;
}

const MAX_READ_BYTES = 128 * 1024;
const DEFAULT_LIMIT = 120;
const MAX_LIMIT = 500;

export class DashboardLogTail {
  private readonly files: Record<DashboardLogStream, string>;

  constructor(logDirectory: string) {
    this.files = {
      stdout: path.join(logDirectory, 'out.log'),
      stderr: path.join(logDirectory, 'error.log'),
    };
  }

  async read(cursor: Partial<DashboardLogCursor>, requestedLimit = DEFAULT_LIMIT): Promise<DashboardLogBatch> {
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(requestedLimit) || DEFAULT_LIMIT));
    const [stdout, stderr] = await Promise.all([
      this.readFile('stdout', cursor.stdout),
      this.readFile('stderr', cursor.stderr),
    ]);
    const entries = [...stdout.entries, ...stderr.entries]
      .sort((left, right) => {
        if (left.timestamp !== null && right.timestamp !== null) return left.timestamp - right.timestamp;
        if (left.timestamp !== null) return -1;
        if (right.timestamp !== null) return 1;
        return 0;
      })
      .slice(-limit);

    return {
      entries,
      cursor: { stdout: stdout.cursor, stderr: stderr.cursor },
      truncated: stdout.truncated || stderr.truncated || stdout.entries.length + stderr.entries.length > limit,
    };
  }

  private async readFile(stream: DashboardLogStream, requestedOffset?: number): Promise<ReadResult> {
    const filename = this.files[stream];
    let size: number;
    try {
      size = (await stat(filename)).size;
    } catch (error) {
      if (isMissingFile(error)) return { entries: [], cursor: 0, truncated: false };
      throw error;
    }

    const hasCursor = Number.isSafeInteger(requestedOffset) && requestedOffset! >= 0 && requestedOffset! <= size;
    const desiredStart = hasCursor ? requestedOffset! : Math.max(0, size - MAX_READ_BYTES);
    const start = Math.max(desiredStart, size - MAX_READ_BYTES);
    const bytesToRead = size - start;
    if (bytesToRead <= 0) return { entries: [], cursor: size, truncated: false };

    const handle = await open(filename, 'r');
    try {
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, start);
      let text = buffer.subarray(0, bytesRead).toString('utf8');
      const startedMidFile = start > 0;
      if (startedMidFile && (!hasCursor || start > requestedOffset!)) {
        const firstNewline = text.indexOf('\n');
        text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
      }
      const entries = text
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .map((line) => parseLogEntry(stream, line));
      return {
        entries,
        cursor: size,
        truncated: (hasCursor && start > requestedOffset!) || (!hasCursor && start > 0),
      };
    } finally {
      await handle.close();
    }
  }
}

function parseLogEntry(stream: DashboardLogStream, text: string): DashboardLogEntry {
  let timestamp: number | null = null;
  let level: string | null = stream === 'stderr' ? 'error' : null;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (typeof value.time === 'number' && Number.isFinite(value.time)) timestamp = value.time;
    if (typeof value.level === 'number') level = pinoLevel(value.level);
    else if (typeof value.level === 'string') level = value.level.toLowerCase();
  } catch {
    const match = text.match(/^(\d{4}-\d{2}-\d{2}[T ][^ ]+)/);
    const parsed = match?.[1] ? Date.parse(match[1]) : Number.NaN;
    if (Number.isFinite(parsed)) timestamp = parsed;
  }
  return { stream, text, timestamp, level };
}

function pinoLevel(level: number): string {
  if (level >= 60) return 'fatal';
  if (level >= 50) return 'error';
  if (level >= 40) return 'warn';
  if (level >= 30) return 'info';
  if (level >= 20) return 'debug';
  return 'trace';
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
