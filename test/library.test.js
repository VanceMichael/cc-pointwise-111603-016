import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from '../src/source-client.js';
import { parsePage, entryPath } from '../src/adapter.js';
import { RecordRepository } from '../src/repository.js';
import { LibraryRepository, LibraryService } from '../src/library.js';
import { acquireDocument } from '../src/documents.js';
import { readOperations } from '../src/operations.js';
import {
  catalogAnnouncement,
  emptyLibraryState,
  FILE_STATUS,
  PENDING_REASON,
  seedNotificationState,
} from '../src/versions.js';

const scenarioPath = new URL('../fixtures/source.json', import.meta.url);
const fixedClock = () => '2026-11-16T12:00:00.000Z';

async function observe(stage) {
  const source = await startSource(scenarioPath);
  try {
    source.publish(stage);
    return parsePage(await new SourceClient(source.url).read(entryPath)).records;
  } finally { await source.close(); }
}

async function withLibrary(run) {
  const directory = await mkdtemp(join(tmpdir(), 'library-test-'));
  try {
    const library = new LibraryService(new LibraryRepository(join(directory, 'library.json')), fixedClock);
    await run(library, directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('公告先入目录为待文件，勘误公告建立替代关系', async () => {
  await withLibrary(async (library) => {
    const opening = await observe('opening');
    assert.equal((await library.catalog(opening)).cataloged, 1);
    let overview = await library.overview();
    assert.equal(overview.standards[0].versions[0].fileStatus, FILE_STATUS.PENDING);
    assert.equal(overview.standards[0].versions[0].pendingReason, PENDING_REASON.AWAITING_COLLECTION);

    const errata = await observe('updated');
    await library.catalog(errata);
    overview = await library.overview();
    const [v1, v2] = overview.standards[0].versions;
    assert.equal(v2.replaces, 'v1');
    assert.equal(v1.replacedBy, 'v2', '旧版被明确替代');
    assert.equal(v2.fileStatus, FILE_STATUS.PENDING, '新版文件未上传时保留待文件');
  });
});

test('文件校验通过才成为可用版本，提醒依据可用版本而非公告出现', async () => {
  const source = await startSource(scenarioPath);
  const directory = await mkdtemp(join(tmpdir(), 'library-test-'));
  try {
    const client = new SourceClient(source.url);
    const library = new LibraryService(new LibraryRepository(join(directory, 'library.json')), fixedClock);

    source.publish('opening');
    await library.catalog(parsePage(await client.read(entryPath)).records);
    let documents = await library.collectDocuments(client);
    assert.equal(documents.usable, 1);
    let reminders = await library.issueReminders();
    assert.equal(reminders.issued.length, 1);
    assert.equal(reminders.issued[0].documentVersion, 'v1');
    assert.equal(reminders.issued[0].basis, 'verified-file');
    assert.match(reminders.issued[0].sha256, /^[0-9a-f]{64}$/);
    assert.equal((await library.issueReminders()).issued.length, 0, '同一版本不重复提醒');

    source.publish('updated');
    await library.catalog(parsePage(await client.read(entryPath)).records);
    documents = await library.collectDocuments(client);
    assert.equal(documents.usable, 0);
    assert.equal(documents.results[0].reason, PENDING_REASON.FILE_MISSING);
    reminders = await library.issueReminders();
    assert.equal(reminders.issued.length, 0, '公告已出现但文件未上传，不产生“已可用”提醒');

    const overview = await library.overview();
    const standard = overview.standards[0];
    assert.equal(standard.latestAnnouncement.documentVersion, 'v2');
    assert.equal(standard.usableVersion.documentVersion, 'v1');
    assert.equal(standard.usableVersion.replaced, true, '旧文件已被明确替代，不能继续当作最新标准');
    assert.equal(standard.notification.documentVersion, 'v1', '通知状态不被公告推进');
    assert.match(standard.summary, /替代/);

    source.publish('ready');
    await library.catalog(parsePage(await client.read(entryPath)).records);
    documents = await library.collectDocuments(client);
    assert.equal(documents.usable, 1, '文件就绪后继续采集即可转正');
    reminders = await library.issueReminders();
    assert.equal(reminders.issued.length, 1);
    assert.equal(reminders.issued[0].documentVersion, 'v2');

    const history = await library.notificationHistory();
    assert.deepEqual(history.log.map((entry) => entry.documentVersion), ['v1', 'v2'], '先前提醒引用的文件可查询');
    assert.equal(history.log[0].file, '/documents/STD-1-v1');
    assert.equal(history.log[1].file, '/documents/STD-1-v2');
    assert.equal(history.state[0].documentVersion, 'v2');
  } finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
});

test('文件采集区分缺失、摘要未知、摘要不一致与来源故障', async () => {
  const entry = { file: '/documents/x', declaredSha256: 'a'.repeat(64) };
  const missing = await acquireDocument({ download: async () => ({ status: 404, ok: false, body: Buffer.from('pending') }) }, entry);
  assert.equal(missing.reason, PENDING_REASON.FILE_MISSING);

  const unknown = await acquireDocument(
    { download: async () => ({ status: 200, ok: true, body: Buffer.from('data') }) },
    { ...entry, declaredSha256: 'unknown' },
  );
  assert.equal(unknown.reason, PENDING_REASON.CHECKSUM_UNKNOWN);

  const mismatch = await acquireDocument(
    { download: async () => ({ status: 200, ok: true, body: Buffer.from('tampered') }) },
    entry,
  );
  assert.equal(mismatch.reason, PENDING_REASON.CHECKSUM_MISMATCH);

  const empty = await acquireDocument(
    { download: async () => ({ status: 200, ok: true, body: Buffer.alloc(0) }) },
    entry,
  );
  assert.equal(empty.reason, PENDING_REASON.FILE_INCOMPLETE);

  const failure = await acquireDocument({ download: async () => { throw new Error('connection reset'); } }, entry);
  assert.equal(failure.reason, PENDING_REASON.SOURCE_ERROR);

  const usable = await acquireDocument(
    { download: async () => ({ status: 200, ok: true, body: Buffer.from('dummy') }) },
    { ...entry, declaredSha256: 'b5a2c96250612366ea272ffac6d9744aaf4b45aacd96aa7cfcb931ee3b558259' },
  );
  assert.equal(usable.outcome, 'usable');
  assert.equal(usable.proof.bytes, 5);
});

test('已校验版本的公告摘要变更时回到待文件', () => {
  const state = emptyLibraryState();
  const record = (sha256) => ({
    sourceId: 'STD-9', source: 's', observedAt: '2026-11-16T08:00:00Z', label: 'l',
    attributes: { standardId: 'STD-9', documentVersion: 'v1', file: '/f', sha256 },
  });
  catalogAnnouncement(state, record('a'.repeat(64)), '2026-11-16T08:00:00Z');
  const entry = state.versions[0];
  entry.fileStatus = FILE_STATUS.USABLE;
  entry.proof = { sha256: 'a'.repeat(64), bytes: 1, verifiedAt: '2026-11-16T08:30:00Z' };
  catalogAnnouncement(state, record('b'.repeat(64)), '2026-11-16T09:00:00Z');
  assert.equal(entry.fileStatus, FILE_STATUS.PENDING);
  assert.equal(entry.pendingReason, PENDING_REASON.CHECKSUM_CHANGED);
  assert.equal(entry.proof, null);
});

test('通知状态种子不覆盖已跟踪标准，历史依据可从版本校验结论解释', async () => {
  await withLibrary(async (library) => {
    await library.catalog(await observe('opening'));
    const source = await startSource(scenarioPath);
    try { await library.collectDocuments(new SourceClient(source.url)); }
    finally { await source.close(); }
    assert.equal((await library.seedNotifications([{ standardId: 'STD-1', documentVersion: 'v1', status: 'pending' }])).seeded, 1);
    assert.equal((await library.seedNotifications([{ standardId: 'STD-1', documentVersion: 'v2', status: 'pending' }])).seeded, 0);
    const history = await library.notificationHistory();
    assert.equal(history.state[0].documentVersion, 'v1');
    assert.equal(history.state[0].file, '/documents/STD-1-v1', '既有通知引用的文件可查询');
    assert.match(history.state[0].sha256, /^[0-9a-f]{64}$/);
    assert.equal((await library.issueReminders()).issued.length, 0, '已通知版本不重复提醒');
  });
});

test('派生状态持久化，重新打开后检索视图一致', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'library-test-'));
  try {
    const path = join(directory, 'library.json');
    const library = new LibraryService(new LibraryRepository(path), fixedClock);
    await library.catalog(await observe('opening'));
    const source = await startSource(scenarioPath);
    try { await library.collectDocuments(new SourceClient(source.url)); }
    finally { await source.close(); }
    await library.issueReminders();
    const reopened = new LibraryService(new LibraryRepository(path), fixedClock);
    assert.deepEqual(await reopened.overview(), await library.overview());
    assert.deepEqual(await reopened.notificationHistory(), await library.notificationHistory());
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('检索入口附带标准级说明且不改动公告行', async () => {
  await withLibrary(async (library) => {
    const records = await observe('updated');
    await library.catalog(records);
    const directory = await mkdtemp(join(tmpdir(), 'library-records-'));
    try {
      const repository = new RecordRepository(join(directory, 'records.json'));
      const withoutLibrary = await readOperations(repository);
      assert.equal(withoutLibrary.standards, undefined);
      const view = await readOperations(repository, await library.state());
      assert.equal(view.standards.length, 1);
      assert.equal(view.standards[0].latestAnnouncement.documentVersion, 'v2');
      assert.equal(view.standards[0].usableVersion, null, 'v2 文件未上传时无可用版本');
      assert.match(view.standards[0].summary, /待文件|尚未可用/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
