import { standardIds, standardView } from './versions.js';

const fields = ["standardId", "title", "documentVersion", "publishedAt", "file", "sha256"];

// 业务检索入口。rows 保持公告记录原样；传入派生状态（libraryState）时，
// 附加 standards 视图说明公告、可用文件版本、替代关系与提醒依据。
export async function readOperations(repository, libraryState = null) {
  const records = await repository.read();
  const result = { product: "标准公告资料库", rows: records.map((record) => ({
    sourceId: record.sourceId,
    source: record.source,
    observedAt: record.observedAt,
    attributes: Object.fromEntries(fields.map((field) => [field, record.attributes[field] ?? null])),
  })) };
  if (libraryState) {
    result.standards = standardIds(libraryState).map((standardId) => standardView(libraryState, standardId));
  }
  return result;
}
