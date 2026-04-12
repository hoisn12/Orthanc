import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { findProjectDir, collectJsonlFiles } from './token-tracker.js';

/**
 * Sync all JSONL files for a project into the token_usage DB table.
 * Uses byte-offset tracking to only parse new data on subsequent calls.
 */
export async function syncAll(provider, projectRoot, tokenStore) {
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
 * Reads only new bytes since last sync offset.
 *
 * For incremental reads (offset > 0), session metadata (sessionId, cwd)
 * may not appear in the new bytes. We first try to recover it from
 * existing DB records for this file, then fall back to the filename.
 */
export async function syncFile(provider, filePath, tokenStore) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return 0; }

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

  const byMessageId = new Map();
  const anonymous = [];

  for await (const line of rl) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }

    // Extract session metadata
    if (!sessionId && (record.sessionId || record.session_id))
      sessionId = record.sessionId || record.session_id;
    if (!cwd && (record.cwd || record.working_directory))
      cwd = record.cwd || record.working_directory;
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

  const records = allUsages.map((u, i) => ({
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
