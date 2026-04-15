import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { findProjectDir, collectJsonlFiles } from './token-tracker.js';
import type { Provider } from './providers/provider.js';
import type { TokenStore } from './token-store.js';
import type { UsageRecord, TokenRecord } from './types.js';

/**
 * Sync all JSONL files for a project into the token_usage DB table.
 * Uses byte-offset tracking to only parse new data on subsequent calls.
 */
export async function syncAll(provider: Provider, projectRoot: string, tokenStore: TokenStore): Promise<{ synced: number; files: number }> {
  const projectsDir = provider.getProjectsDir();
  const projectDir = findProjectDir(projectsDir, projectRoot);
  if (!projectDir) return { synced: 0, files: 0 };

  const jsonlFiles = collectJsonlFiles(projectDir);
  if (jsonlFiles.length === 0) return { synced: 0, files: 0 };

  let totalSynced = 0;
  for (const filePath of jsonlFiles) {
    const count = await syncFile(provider, filePath, tokenStore);
    totalSynced += count;
  }

  return { synced: totalSynced, files: jsonlFiles.length };
}

/**
 * Incrementally sync a single JSONL file into the DB.
 */
export async function syncFile(provider: Provider, filePath: string, tokenStore: TokenStore): Promise<number> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return 0;
  }

  const savedOffset = tokenStore.getSyncState(filePath);

  // Handle file truncation
  const offset = stat.size < savedOffset ? 0 : savedOffset;
  if (stat.size <= offset) return 0;

  const sessionFile = path.basename(filePath);

  // For incremental sync, pre-fill session metadata from existing DB records
  let sessionId = '';
  let cwd = '';
  let startedAt = '';
  let lastActivity = '';

  if (offset > 0) {
    const existing = tokenStore.getSessionMeta(sessionFile);
    if (existing) {
      sessionId = existing.sessionId;
      cwd = existing.cwd;
      startedAt = existing.startedAt;
    }
  }

  // Read new bytes
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8', start: offset });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const byMessageId = new Map<string, UsageRecord>();
  const anonymous: UsageRecord[] = [];

  for await (const line of rl) {
    if (!line.trim()) continue;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    // Extract session metadata
    if (!sessionId && (record.sessionId || record.session_id)) sessionId = record.sessionId || record.session_id;
    if (!cwd && (record.cwd || record.working_directory)) cwd = record.cwd || record.working_directory;
    if (record.timestamp) {
      if (!startedAt) startedAt = record.timestamp;
      lastActivity = record.timestamp;
    }

    const usage = provider.parseUsageRecord(record);
    if (!usage) continue;

    if (usage.messageId) {
      byMessageId.set(usage.messageId, usage);
    } else {
      anonymous.push(usage);
    }
  }

  const allUsages = [...byMessageId.values(), ...anonymous];
  if (allUsages.length === 0) {
    tokenStore.setSyncState(filePath, stat.size);
    return 0;
  }

  // Derive sessionId from filename if still missing
  if (!sessionId) {
    sessionId = sessionFile.replace('.jsonl', '');
  }

  const records: TokenRecord[] = allUsages.map((u, i) => ({
    id: u.messageId || `${sessionFile}-${u.timestamp}-${i}`,
    sessionId,
    sessionFile,
    timestamp: u.timestamp,
    model: u.model,
    input: u.input,
    output: u.output,
    cacheRead: u.cacheRead,
    cacheCreate: u.cacheCreate,
    cwd,
    startedAt,
    lastActivity,
  }));

  tokenStore.bulkUpsert(records);
  tokenStore.setSyncState(filePath, stat.size);

  return records.length;
}
