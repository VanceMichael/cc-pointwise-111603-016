import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { LibraryRepository, LibraryService } from './library.js';
import { SourceClient } from './source-client.js';
import { parsePage, entryPath } from './adapter.js';
import { readOperations } from './operations.js';

const here = dirname(fileURLToPath(import.meta.url));
const service = new CollectionService(new RecordRepository(resolve(here, '../var/records.json')));
const library = new LibraryService(new LibraryRepository(resolve(here, '../var/library.json')));

const commands = ['ingest', 'query', 'collect', 'status', 'notify', 'notifications'];
const action = process.argv[2] ?? '--help';
if (action === '--help' || action === '-h') {
  console.log(JSON.stringify({
    usage: 'npm start -- ingest [文件] | query [来源] | collect <来源URL> | status | notify | notifications',
    commands,
  }));
  process.exit(0);
}
if (action === 'ingest') {
  const records = JSON.parse(await readFile(process.argv[3] ?? resolve(here, '../fixtures/records.json'), 'utf8'));
  console.log(JSON.stringify(await service.ingest(records), null, 2));
} else if (action === 'query') {
  console.log(JSON.stringify(await service.query({ source: process.argv[3] }), null, 2));
} else if (action === 'collect') {
  const sourceUrl = process.argv[3];
  if (!sourceUrl) throw new Error('collect 需要来源 URL（仅允许本机回环来源）');
  const client = new SourceClient(sourceUrl);
  const page = parsePage(await client.read(entryPath));
  const ingested = await service.ingest(page.records);
  const cataloged = await library.catalog(page.records);
  const documents = await library.collectDocuments(client);
  console.log(JSON.stringify({ ingested, cataloged, documents }, null, 2));
} else if (action === 'status') {
  console.log(JSON.stringify(await readOperations(
    new RecordRepository(resolve(here, '../var/records.json')),
    await library.state(),
  ), null, 2));
} else if (action === 'notify') {
  console.log(JSON.stringify(await library.issueReminders(), null, 2));
} else if (action === 'notifications') {
  console.log(JSON.stringify(await library.notificationHistory(), null, 2));
} else {
  throw new Error(`action must be one of: ${commands.join(', ')}`);
}
