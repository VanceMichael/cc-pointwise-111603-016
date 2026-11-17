import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('命令帮助列出导入和查询入口且正常退出', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', '--help'], {encoding: 'utf8'});
  assert.equal(result.status, 0);
  const help = JSON.parse(result.stdout);
  assert.ok(help.usage.includes('ingest'));
  assert.ok(help.usage.includes('collect'));
  assert.deepEqual(help.commands, ['ingest', 'query', 'collect', 'status', 'notify', 'notifications']);
});

test('未知动作明确失败而不执行默认查询', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', 'invalid-action'], {encoding: 'utf8'});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /action must be one of:.*ingest.*query.*collect/);
});

test('collect 缺少来源 URL 时明确失败', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', 'collect'], {encoding: 'utf8'});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /来源 URL/);
});
