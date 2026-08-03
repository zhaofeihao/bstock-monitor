import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DashboardLogTail } from './log-tail.js';

test('reads an initial bounded tail and then only appended log lines', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bstock-log-tail-'));
  try {
    const stdout = path.join(directory, 'out.log');
    const stderr = path.join(directory, 'error.log');
    await writeFile(
      stdout,
      [
        JSON.stringify({ level: 30, time: 1_000, msg: 'monitor started' }),
        JSON.stringify({ level: 40, time: 2_000, msg: 'rpc delayed' }),
        '',
      ].join('\n'),
    );
    await writeFile(stderr, '2026-08-03T12:00:00.000Z fatal sample\n');

    const tail = new DashboardLogTail(directory);
    const initial = await tail.read({}, 10);
    assert.equal(initial.entries.length, 3);
    assert.deepEqual(initial.entries.map((entry) => entry.level), ['info', 'warn', 'error']);

    await appendFile(stdout, `${JSON.stringify({ level: 50, time: 3_000, msg: 'quote failed' })}\n`);
    const incremental = await tail.read(initial.cursor, 10);
    assert.equal(incremental.entries.length, 1);
    assert.equal(incremental.entries[0]?.level, 'error');
    assert.match(incremental.entries[0]?.text ?? '', /quote failed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('returns an empty batch when PM2 log files do not exist yet', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bstock-log-tail-empty-'));
  try {
    const batch = await new DashboardLogTail(directory).read({}, 20);
    assert.deepEqual(batch.entries, []);
    assert.deepEqual(batch.cursor, { stdout: 0, stderr: 0 });
    assert.equal(batch.truncated, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
