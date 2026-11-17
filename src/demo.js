import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from './source-client.js';
import { parsePage, entryPath } from './adapter.js';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { LibraryRepository, LibraryService } from './library.js';
import { readOperations } from './operations.js';

const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'collection-demo-'));
try {
  const client = new SourceClient(source.url);
  const recordRepository = new RecordRepository(join(directory, 'records.json'));
  const service = new CollectionService(recordRepository);
  const library = new LibraryService(new LibraryRepository(join(directory, 'library.json')));

  // 既有通知消费状态：STD-1 v1 的提醒已发出、消费待确认。
  const notifications = JSON.parse(await readFile(new URL('../fixtures/notifications.json', import.meta.url), 'utf8'));
  console.log(JSON.stringify({ step: 'seed-notifications', ...(await library.seedNotifications(notifications)) }));

  // opening：v1 公告入目录，文件校验通过成为可用版本；v1 已在通知状态中，不重复提醒。
  // updated：v2 勘误公告声明替代 v1，但文件尚未上传——保留待文件，不产生“已可用”提醒。
  // ready：v2 文件上传且校验通过，成为可用版本，提醒依据指向 v2 文件。
  for (const stage of ['opening', 'updated', 'ready']) {
    source.publish(stage);
    const page = parsePage(await client.read(entryPath));
    const ingested = await service.ingest(page.records);
    const cataloged = await library.catalog(page.records);
    const documents = await library.collectDocuments(client);
    const reminders = await library.issueReminders();
    console.log(JSON.stringify({ step: 'collect', stage, ingested, cataloged, documents, reminders }, null, 2));
  }

  console.log(JSON.stringify({ step: 'status', ...(await readOperations(recordRepository, await library.state())) }, null, 2));
  console.log(JSON.stringify({ step: 'notifications', ...(await library.notificationHistory()) }, null, 2));
} finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
