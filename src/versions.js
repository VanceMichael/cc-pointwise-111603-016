// 公告目录、正式文件版本与提醒依据的领域逻辑（纯函数，状态由 LibraryRepository 持久化）。
//
// 生命周期：公告先入目录（pending-file 待文件）→ 文件下载且 sha256 校验通过（usable 可用）。
// 勘误公告以 replaces 声明替代旧版；旧版文件即使仍可用，也被标记为“已被明确替代”，
// 不再作为最新标准提醒。提醒只依据校验通过的可用版本，而不是公告是否出现。

export const FILE_STATUS = Object.freeze({
  PENDING: 'pending-file',
  USABLE: 'usable',
});

export const PENDING_REASON = Object.freeze({
  AWAITING_COLLECTION: 'awaiting-collection',
  FILE_MISSING: 'file-missing',
  FILE_INCOMPLETE: 'file-incomplete',
  CHECKSUM_UNKNOWN: 'checksum-unknown',
  CHECKSUM_MISMATCH: 'checksum-mismatch',
  CHECKSUM_CHANGED: 'checksum-changed',
  SOURCE_ERROR: 'source-error',
});

export const PENDING_REASON_TEXT = Object.freeze({
  [PENDING_REASON.AWAITING_COLLECTION]: '公告已入目录，文件尚未采集',
  [PENDING_REASON.FILE_MISSING]: '来源尚未上传该文件',
  [PENDING_REASON.FILE_INCOMPLETE]: '文件内容不完整',
  [PENDING_REASON.CHECKSUM_UNKNOWN]: '公告未给出可校验的 sha256，无法校验',
  [PENDING_REASON.CHECKSUM_MISMATCH]: '文件 sha256 与公告摘要不一致',
  [PENDING_REASON.CHECKSUM_CHANGED]: '公告摘要变更，已校验文件需重新校验',
  [PENDING_REASON.SOURCE_ERROR]: '来源暂时不可用，稍后可继续采集',
});

export const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

export function emptyLibraryState() {
  return { versions: [], notifications: { state: {}, log: [] } };
}

export function standardIds(state) {
  return [...new Set(state.versions.map((entry) => entry.standardId))].sort();
}

function findVersion(state, standardId, documentVersion) {
  return state.versions.find(
    (entry) => entry.standardId === standardId && entry.documentVersion === documentVersion,
  ) ?? null;
}

function sortVersions(entries) {
  return [...entries].sort((left, right) =>
    left.announcedAt.localeCompare(right.announcedAt)
    || left.documentVersion.localeCompare(right.documentVersion));
}

// 重新计算某标准下各版本的 replacedBy：被任何其他公告以 replaces 明确指向的版本即被替代。
function refreshReplacements(state, standardId) {
  const entries = state.versions.filter((entry) => entry.standardId === standardId);
  for (const entry of entries) {
    const successor = entries.find(
      (other) => other !== entry && other.replaces === entry.documentVersion,
    );
    entry.replacedBy = successor ? successor.documentVersion : null;
  }
}

// 公告入目录。返回是否登记了一个版本（缺少 standardId/documentVersion 的记录跳过）。
export function catalogAnnouncement(state, record, now) {
  const attributes = record.attributes ?? {};
  const standardId = String(attributes.standardId ?? record.sourceId ?? '').trim();
  const documentVersion = String(attributes.documentVersion ?? '').trim();
  if (!standardId || !documentVersion) return false;

  const announcement = {
    title: String(attributes.title ?? record.label ?? '').trim(),
    publishedAt: String(attributes.publishedAt ?? record.observedAt ?? '').trim(),
    announcedAt: String(record.observedAt ?? '').trim(),
    file: attributes.file ? String(attributes.file) : null,
    declaredSha256: attributes.sha256 ? String(attributes.sha256).trim().toLowerCase() : null,
    replaces: attributes.replaces ? String(attributes.replaces).trim() : null,
  };

  const existing = findVersion(state, standardId, documentVersion);
  if (existing) {
    // 只接受不早于已登记公告的观察，避免旧观察覆盖新目录信息。
    if (Date.parse(announcement.announcedAt) >= Date.parse(existing.announcedAt)) {
      const shaChanged = announcement.declaredSha256
        && SHA256_PATTERN.test(announcement.declaredSha256)
        && announcement.declaredSha256 !== existing.declaredSha256;
      Object.assign(existing, announcement);
      // 已校验文件的公告摘要发生变化：原校验结论不再有效，回到待文件等待重新采集。
      if (existing.fileStatus === FILE_STATUS.USABLE && shaChanged && existing.proof?.sha256 !== announcement.declaredSha256) {
        existing.fileStatus = FILE_STATUS.PENDING;
        existing.pendingReason = PENDING_REASON.CHECKSUM_CHANGED;
        existing.proof = null;
      }
    }
  } else {
    state.versions.push({
      standardId,
      documentVersion,
      ...announcement,
      catalogedAt: now,
      fileStatus: FILE_STATUS.PENDING,
      pendingReason: PENDING_REASON.AWAITING_COLLECTION,
      proof: null,
      replacedBy: null,
      attempts: 0,
      lastAttemptAt: null,
      lastError: null,
    });
  }
  refreshReplacements(state, standardId);
  return true;
}

// 记录一次文件采集结果：成功则成为可用版本，失败则保留待文件并允许后续继续采集。
export function recordAcquisition(state, standardId, documentVersion, result, now) {
  const entry = findVersion(state, standardId, documentVersion);
  if (!entry) return false;
  entry.attempts += 1;
  entry.lastAttemptAt = now;
  if (result.outcome === 'usable') {
    entry.fileStatus = FILE_STATUS.USABLE;
    entry.pendingReason = null;
    entry.lastError = null;
    entry.proof = { sha256: result.proof.sha256, bytes: result.proof.bytes, verifiedAt: now };
  } else {
    entry.fileStatus = FILE_STATUS.PENDING;
    entry.pendingReason = result.reason;
    entry.lastError = result.detail ?? null;
  }
  return true;
}

function publicVersion(entry) {
  return {
    documentVersion: entry.documentVersion,
    title: entry.title,
    publishedAt: entry.publishedAt,
    announcedAt: entry.announcedAt,
    fileStatus: entry.fileStatus,
    pendingReason: entry.pendingReason,
    pendingText: entry.pendingReason ? PENDING_REASON_TEXT[entry.pendingReason] ?? entry.pendingReason : null,
    replaces: entry.replaces,
    replacedBy: entry.replacedBy,
    file: entry.file,
    sha256: entry.proof?.sha256 ?? null,
    bytes: entry.proof?.bytes ?? null,
    verifiedAt: entry.proof?.verifiedAt ?? null,
    attempts: entry.attempts,
  };
}

// 提醒依据：先前提醒引用过的文件。优先取提醒日志，其次用版本校验结论解释通知状态。
export function notificationBasis(state, standardId) {
  const current = state.notifications.state[standardId];
  if (!current) return null;
  const logged = [...state.notifications.log].reverse().find(
    (entry) => entry.standardId === standardId && entry.documentVersion === current.documentVersion,
  );
  if (logged) return { ...logged, source: 'log' };
  const version = findVersion(state, standardId, current.documentVersion);
  return {
    standardId,
    documentVersion: current.documentVersion,
    status: current.status,
    updatedAt: current.updatedAt,
    file: version?.file ?? null,
    sha256: version?.proof?.sha256 ?? null,
    verifiedAt: version?.proof?.verifiedAt ?? null,
    source: version ? 'versions' : 'state',
  };
}

function summaryFor(latest, usable) {
  if (!latest) return '暂无公告。';
  if (latest.fileStatus === FILE_STATUS.USABLE) {
    return latest.replaces
      ? `最新公告版本 ${latest.documentVersion}（替代 ${latest.replaces}）文件已校验通过，是当前有效标准。`
      : `最新公告版本 ${latest.documentVersion} 文件已校验通过，是当前有效标准。`;
  }
  const pending = PENDING_REASON_TEXT[latest.pendingReason] ?? '待文件';
  if (usable) {
    return `勘误/新版 ${latest.documentVersion} 已公告并明确替代 ${usable.documentVersion}，但正式文件尚未可用（${pending}）；`
      + `${usable.documentVersion} 仍是最近可用版本，但已被明确替代，不再作为最新标准提醒。`;
  }
  return `最新公告版本 ${latest.documentVersion} 的正式文件尚未可用（${pending}），暂无校验通过的可用版本。`;
}

// 检索视图：把公告、文件版本、替代关系与提醒依据放在同一标准下说明。
export function standardView(state, standardId) {
  const entries = sortVersions(state.versions.filter((entry) => entry.standardId === standardId));
  const latest = entries.at(-1) ?? null;
  const usable = [...entries].reverse().find((entry) => entry.fileStatus === FILE_STATUS.USABLE) ?? null;
  const notified = state.notifications.state[standardId] ?? null;
  return {
    standardId,
    title: latest?.title ?? null,
    latestAnnouncement: latest ? publicVersion(latest) : null,
    usableVersion: usable ? { ...publicVersion(usable), replaced: Boolean(usable.replacedBy) } : null,
    versions: entries.map(publicVersion),
    notification: notificationBasis(state, standardId),
    reminderPending: Boolean(
      latest && latest.fileStatus === FILE_STATUS.USABLE && notified?.documentVersion !== latest.documentVersion,
    ),
    summary: summaryFor(latest, usable),
  };
}

// 到期提醒：仅当最新公告版本的文件已校验通过、且通知状态尚未覆盖该版本时才提醒。
// 待文件的新公告与已被替代的旧可用版本都不会产生提醒。
export function dueReminders(state) {
  const due = [];
  for (const standardId of standardIds(state)) {
    const entries = sortVersions(state.versions.filter((entry) => entry.standardId === standardId));
    const latest = entries.at(-1);
    if (!latest || latest.fileStatus !== FILE_STATUS.USABLE) continue;
    if (state.notifications.state[standardId]?.documentVersion === latest.documentVersion) continue;
    due.push({
      standardId,
      documentVersion: latest.documentVersion,
      title: latest.title,
      file: latest.file,
      sha256: latest.proof.sha256,
      bytes: latest.proof.bytes,
      verifiedAt: latest.proof.verifiedAt,
      announcedAt: latest.announcedAt,
      publishedAt: latest.publishedAt,
      replaces: latest.replaces,
      basis: 'verified-file',
    });
  }
  return due;
}

// 记录提醒：追加提醒日志（含引用的文件与校验依据），并推进通知消费状态。
export function applyReminders(state, issued, now) {
  for (const reminder of issued) {
    state.notifications.log.push({ ...reminder, status: 'pending', issuedAt: now });
    state.notifications.state[reminder.standardId] = {
      documentVersion: reminder.documentVersion,
      status: 'pending',
      updatedAt: now,
    };
  }
  return state;
}

// 导入既有通知消费状态（如 fixtures/notifications.json），不覆盖已跟踪的标准。
export function seedNotificationState(state, entries, now) {
  let seeded = 0;
  for (const entry of entries) {
    const standardId = String(entry.standardId ?? '').trim();
    const documentVersion = String(entry.documentVersion ?? '').trim();
    if (!standardId || !documentVersion || state.notifications.state[standardId]) continue;
    state.notifications.state[standardId] = {
      documentVersion,
      status: String(entry.status ?? 'pending'),
      updatedAt: now,
    };
    seeded += 1;
  }
  return seeded;
}

export function notificationHistory(state) {
  return {
    state: Object.keys(state.notifications.state).sort().map((standardId) => notificationBasis(state, standardId)),
    log: state.notifications.log.map((entry) => ({ ...entry, source: 'log' })),
  };
}
