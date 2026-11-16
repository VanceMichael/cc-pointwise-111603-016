const fields = ["standardId", "title", "documentVersion", "publishedAt", "file", "sha256"];

export async function readOperations(repository) {
  const records = await repository.read();
  return { product: "标准公告资料库", rows: records.map((record) => ({
    sourceId: record.sourceId,
    source: record.source,
    observedAt: record.observedAt,
    attributes: Object.fromEntries(fields.map((field) => [field, record.attributes[field] ?? null])),
  })) };
}
