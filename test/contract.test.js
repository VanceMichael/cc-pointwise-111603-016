import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { startSource } from '../source/server.js';
import { parsePage, entryPath } from '../src/adapter.js';
import { SourceClient } from '../src/source-client.js';

async function observe(stage = 'opening', path = entryPath) {
  const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
  try {
    source.publish(stage);
    return parsePage(await new SourceClient(source.url).read(path));
  } finally { await source.close(); }
}

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));
}

test('replacement announcement can precede its document without erasing the old file', async () => {
  const announced = (await observe('updated')).records[0].attributes;
  assert.equal(announced.documentVersion, 'v2');
  assert.equal(announced.replaces, 'v1');
  const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
  try {
    source.publish('updated');
    assert.equal((await fetch(`${source.url}${announced.file}`)).status, 404);
    assert.equal((await fetch(`${source.url}/documents/STD-1-v1`)).status, 200);
    assert.equal((await fixture('notifications'))[0].documentVersion, 'v1');
  } finally { await source.close(); }
});
