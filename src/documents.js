import { createHash } from 'node:crypto';
import { PENDING_REASON, SHA256_PATTERN } from './versions.js';

// 正式文件采集：只有完整下载且 sha256 校验通过的文件才返回 usable，
// 其余情况一律保持待文件，调用方记录原因后可继续采集。
export async function acquireDocument(client, entry) {
  if (!entry.file) {
    return { outcome: 'pending', reason: PENDING_REASON.FILE_MISSING, detail: '公告未给出文件路径' };
  }
  let response;
  try {
    response = await client.download(entry.file);
  } catch (error) {
    return { outcome: 'pending', reason: PENDING_REASON.SOURCE_ERROR, detail: String(error.message ?? error) };
  }
  if (response.status === 404) {
    return { outcome: 'pending', reason: PENDING_REASON.FILE_MISSING, detail: `来源返回 404: ${entry.file}` };
  }
  if (!response.ok) {
    return { outcome: 'pending', reason: PENDING_REASON.SOURCE_ERROR, detail: `来源返回 ${response.status}: ${entry.file}` };
  }
  const body = response.body;
  if (!body || body.length === 0) {
    return { outcome: 'pending', reason: PENDING_REASON.FILE_INCOMPLETE, detail: '文件内容为空' };
  }
  const declared = String(entry.declaredSha256 ?? '').toLowerCase();
  if (!SHA256_PATTERN.test(declared)) {
    return { outcome: 'pending', reason: PENDING_REASON.CHECKSUM_UNKNOWN, detail: `公告摘要不可校验: ${entry.declaredSha256 ?? '缺失'}` };
  }
  const actual = createHash('sha256').update(body).digest('hex');
  if (actual !== declared) {
    return { outcome: 'pending', reason: PENDING_REASON.CHECKSUM_MISMATCH, detail: `期望 ${declared}，实际 ${actual}` };
  }
  return { outcome: 'usable', proof: { sha256: actual, bytes: body.length } };
}
