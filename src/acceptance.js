import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from '../src/source-client.js';
import { parsePage, entryPath } from '../src/adapter.js';
import { RecordRepository } from '../src/repository.js';
import { CollectionService } from '../src/service.js';
import { LibraryRepository, LibraryService } from '../src/library.js';
import { readOperations } from '../src/operations.js';

const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'collection-acceptance-'));
try {
  const client = new SourceClient(source.url);
  const page = parsePage(await client.read(entryPath));
  assert.ok(page.records.length > 0, '初始来源须有可接收的业务记录');
  const path = join(directory, 'records.json');
  const repository = new RecordRepository(path);
  const first = await new CollectionService(repository).ingest(page.records);
  assert.equal(first.accepted, page.records.length);
  const stored = await repository.read();
  const reopened = new RecordRepository(path);
  assert.deepEqual(await new CollectionService(reopened).query({}), stored, '重新打开后读取同一份业务记录');
  const second = await new CollectionService(reopened).ingest(page.records);
  assert.equal(second.stored, stored.length, '重放首批记录不重复保存');
  const operations = await readOperations(reopened);
  assert.deepEqual(operations.rows.map(row => row.sourceId), stored.map(row => row.sourceId));
  for (const row of operations.rows) {
    const original = stored.find(record => record.sourceId === row.sourceId);
    assert.equal(row.source, original.source);
    assert.equal(row.observedAt, original.observedAt);
    for (const [field, value] of Object.entries(row.attributes)) assert.deepEqual(value, original.attributes[field] ?? null);
  }

  // 生命周期基线：公告入目录 → 文件校验 → 提醒依据。
  const service = new CollectionService(reopened);
  const library = new LibraryService(new LibraryRepository(join(directory, 'library.json')));
  await library.catalog(stored);
  const openingDocuments = await library.collectDocuments(client);
  assert.equal(openingDocuments.usable, 1, 'v1 文件校验通过后成为可用版本');
  const openingReminders = await library.issueReminders();
  assert.equal(openingReminders.issued.length, 1, 'v1 可用且未通知过，应产生一次提醒');
  assert.equal(openingReminders.issued[0].documentVersion, 'v1');
  assert.equal(openingReminders.issued[0].sha256, stored[0].attributes.sha256, '提醒依据引用校验过的文件摘要');

  source.publish('updated');
  const errataPage = parsePage(await client.read(entryPath));
  await service.ingest(errataPage.records);
  await library.catalog(errataPage.records);
  const updatedDocuments = await library.collectDocuments(client);
  assert.equal(updatedDocuments.usable, 0, 'v2 文件尚未上传，不能成为可用版本');
  assert.equal(updatedDocuments.results[0].reason, 'file-missing');
  const updatedReminders = await library.issueReminders();
  assert.equal(updatedReminders.issued.length, 0, '公告出现但文件未上传，不再产生“已可用”提醒');
  const updatedView = await readOperations(reopened, await library.state());
  const standard = updatedView.standards.find((row) => row.standardId === 'STD-1');
  assert.equal(standard.latestAnnouncement.documentVersion, 'v2');
  assert.equal(standard.latestAnnouncement.fileStatus, 'pending-file');
  assert.equal(standard.usableVersion.documentVersion, 'v1', 'v1 仍是最近可用版本');
  assert.equal(standard.usableVersion.replaced, true, 'v1 已被 v2 明确替代，不能当作最新标准通知');
  assert.equal(standard.notification.documentVersion, 'v1', '通知状态仍停留在 v1');

  source.publish('ready');
  const readyPage = parsePage(await client.read(entryPath));
  await service.ingest(readyPage.records);
  await library.catalog(readyPage.records);
  const readyDocuments = await library.collectDocuments(client);
  assert.equal(readyDocuments.usable, 1, 'v2 文件上传且校验通过后成为可用版本');
  const readyReminders = await library.issueReminders();
  assert.equal(readyReminders.issued.length, 1);
  assert.equal(readyReminders.issued[0].documentVersion, 'v2');
  const history = await library.notificationHistory();
  assert.deepEqual(history.log.map((entry) => entry.documentVersion), ['v1', 'v2'], '先前提醒引用的文件版本应可查询');
  assert.ok(history.log.every((entry) => entry.file && entry.sha256), '每次提醒都记录引用的文件与摘要');

  console.log(JSON.stringify({accepted: first.accepted, persisted: stored.length, replayStored: second.stored, operationRows: operations.rows.length, reminders: history.log.length, status: 'ok'}));
} finally {
  await source.close();
  await rm(directory, {recursive: true, force: true});
}
