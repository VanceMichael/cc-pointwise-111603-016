import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { acquireDocument } from './documents.js';
import {
  applyReminders,
  catalogAnnouncement,
  dueReminders,
  emptyLibraryState,
  FILE_STATUS,
  notificationHistory,
  recordAcquisition,
  seedNotificationState,
  standardIds,
  standardView,
} from './versions.js';

// 派生状态（文件版本、替代关系、提醒依据）的持久化，与公告记录集合分开组织。
export class LibraryRepository {
  constructor(path) { this.path = path; }

  async read() {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'));
      const state = emptyLibraryState();
      if (Array.isArray(value.versions)) state.versions = value.versions;
      if (value.notifications && typeof value.notifications === 'object') {
        state.notifications.state = value.notifications.state ?? {};
        state.notifications.log = Array.isArray(value.notifications.log) ? value.notifications.log : [];
      }
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return emptyLibraryState();
      throw error;
    }
  }

  async replace(state) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, this.path);
  }
}

// 采集生命周期编排：公告入目录 → 文件采集校验 → 依据可用版本生成提醒。
export class LibraryService {
  constructor(repository, clock = () => new Date().toISOString()) {
    this.repository = repository;
    this.clock = clock;
  }

  async state() { return this.repository.read(); }

  async catalog(records) {
    const state = await this.repository.read();
    let cataloged = 0;
    for (const record of records) {
      if (catalogAnnouncement(state, record, this.clock())) cataloged += 1;
    }
    await this.repository.replace(state);
    return { cataloged, versions: state.versions.length };
  }

  // 对所有待文件版本尝试采集；单个失败不影响其他版本，下次运行会重试。
  async collectDocuments(client) {
    const state = await this.repository.read();
    const results = [];
    for (const entry of state.versions) {
      if (entry.fileStatus !== FILE_STATUS.PENDING) continue;
      const result = await acquireDocument(client, entry);
      recordAcquisition(state, entry.standardId, entry.documentVersion, result, this.clock());
      results.push({
        standardId: entry.standardId,
        documentVersion: entry.documentVersion,
        outcome: result.outcome,
        reason: result.reason ?? null,
        detail: result.detail ?? null,
      });
    }
    if (results.length) await this.repository.replace(state);
    return {
      checked: results.length,
      usable: results.filter((result) => result.outcome === 'usable').length,
      pending: results.filter((result) => result.outcome !== 'usable').length,
      results,
    };
  }

  // 只依据校验通过的可用版本生成提醒；公告出现但文件待校验时不产生提醒。
  async issueReminders() {
    const state = await this.repository.read();
    const issued = dueReminders(state);
    if (issued.length) {
      applyReminders(state, issued, this.clock());
      await this.repository.replace(state);
    }
    return { issued };
  }

  async overview() {
    const state = await this.repository.read();
    return { standards: standardIds(state).map((standardId) => standardView(state, standardId)) };
  }

  async notificationHistory() {
    return notificationHistory(await this.repository.read());
  }

  async seedNotifications(entries) {
    const state = await this.repository.read();
    const seeded = seedNotificationState(state, entries, this.clock());
    if (seeded) await this.repository.replace(state);
    return { seeded };
  }
}
