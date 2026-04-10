import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Pricing per 1M tokens (USD) by model
const MODEL_PRICING = {
  'claude-opus-4-6':   { input: 15,  output: 75,  cache_read: 1.5,   cache_create: 18.75 },
  'claude-opus-4-5':   { input: 15,  output: 75,  cache_read: 1.5,   cache_create: 18.75 },
  'claude-sonnet-4-6': { input: 3,   output: 15,  cache_read: 0.3,   cache_create: 3.75  },
  'claude-sonnet-4-5': { input: 3,   output: 15,  cache_read: 0.3,   cache_create: 3.75  },
  'claude-haiku-4-5':  { input: 0.8, output: 4,   cache_read: 0.08,  cache_create: 1     },
};

// Fallback for unknown models
const DEFAULT_PRICING = { input: 3, output: 15, cache_read: 0.3, cache_create: 3.75 };

function getPricing(model) {
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith(key)) return pricing;
  }
  return DEFAULT_PRICING;
}

export async function getTokenUsage(projectRoot) {
  const projectDirName = projectRoot.replace(/\//g, '-').replace(/^-/, '-');
  // ~/.claude/projects/ uses path encoding like -Users-hongyeolchae-project-name
  const candidates = findProjectDir(projectRoot);
  if (!candidates) return emptyResult();

  const jsonlFiles = collectJsonlFiles(candidates);
  if (jsonlFiles.length === 0) return emptyResult();

  const sessions = [];

  for (const file of jsonlFiles) {
    const session = await parseJsonlFile(file);
    if (session.totalOutput > 0 || session.totalInput > 0) {
      sessions.push(session);
    }
  }

  // Aggregate
  const totals = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  const byModel = {};
  const timeline = [];

  for (const s of sessions) {
    totals.input += s.totalInput;
    totals.output += s.totalOutput;
    totals.cacheRead += s.totalCacheRead;
    totals.cacheCreate += s.totalCacheCreate;

    for (const [model, counts] of Object.entries(s.byModel)) {
      if (!byModel[model]) byModel[model] = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
      byModel[model].input += counts.input;
      byModel[model].output += counts.output;
      byModel[model].cacheRead += counts.cacheRead;
      byModel[model].cacheCreate += counts.cacheCreate;
    }

    timeline.push(...s.messages);
  }

  // Sort timeline by timestamp
  timeline.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  // Group by hour for chart data
  const hourly = {};
  for (const msg of timeline) {
    const hour = msg.timestamp.slice(0, 13); // "2026-04-10T05"
    if (!hourly[hour]) hourly[hour] = { input: 0, output: 0 };
    hourly[hour].input += msg.input;
    hourly[hour].output += msg.output;
  }

  const cost = estimateCostByModel(byModel);

  // Build per-session summary sorted by most recent first
  const sessionList = sessions.map((s) => {
    const total = s.totalInput + s.totalOutput + s.totalCacheRead + s.totalCacheCreate;
    return {
      sessionId: s.sessionId,
      file: s.file,
      startedAt: s.startedAt,
      lastActivity: s.lastActivity,
      cwd: s.cwd,
      input: s.totalInput,
      output: s.totalOutput,
      cacheRead: s.totalCacheRead,
      cacheCreate: s.totalCacheCreate,
      total,
      cost: estimateCostByModel(s.byModel),
      messageCount: s.messages.length,
      models: Object.keys(s.byModel),
    };
  }).sort((a, b) => new Date(b.startedAt || 0) - new Date(a.startedAt || 0));

  // Add per-model cost
  const byModelWithCost = {};
  for (const [model, counts] of Object.entries(byModel)) {
    byModelWithCost[model] = {
      ...counts,
      cost: estimateCostByModel({ [model]: counts }),
    };
  }

  return {
    totals,
    cost,
    byModel: byModelWithCost,
    hourly,
    sessionCount: sessions.length,
    messageCount: timeline.length,
    recent24h: calcRecent(timeline, 24 * 60 * 60 * 1000),
    sessions: sessionList,
  };
}

function findProjectDir(projectRoot) {
  if (!fs.existsSync(PROJECTS_DIR)) return null;

  const encoded = projectRoot.replaceAll('/', '-');
  const target = path.join(PROJECTS_DIR, encoded);
  if (fs.existsSync(target)) return target;

  // Fallback: scan for matching directory
  try {
    const dirs = fs.readdirSync(PROJECTS_DIR);
    const match = dirs.find((d) => {
      const decoded = d.replaceAll('-', '/');
      return decoded.endsWith(projectRoot) || projectRoot.endsWith(decoded.slice(1));
    });
    if (match) return path.join(PROJECTS_DIR, match);
  } catch { /* ignore */ }

  return null;
}

function collectJsonlFiles(dir) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        results.push(full);
      } else if (entry.isDirectory()) {
        // Check subagents
        results.push(...collectJsonlFiles(full));
      }
    }
  } catch { /* ignore */ }
  return results;
}

async function parseJsonlFile(filePath) {
  const session = {
    file: path.basename(filePath),
    sessionId: '',
    startedAt: '',
    lastActivity: '',
    cwd: '',
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheCreate: 0,
    byModel: {},
    messages: [],
  };

  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);

      // Capture session metadata from any record
      if (!session.sessionId && record.sessionId) session.sessionId = record.sessionId;
      if (!session.cwd && record.cwd) session.cwd = record.cwd;
      if (record.timestamp) {
        if (!session.startedAt) session.startedAt = record.timestamp;
        session.lastActivity = record.timestamp;
      }

      const usage = record.message?.usage;
      if (!usage) continue;

      const input = usage.input_tokens || 0;
      const output = usage.output_tokens || 0;
      const cacheRead = usage.cache_read_input_tokens || 0;
      const cacheCreate = usage.cache_creation_input_tokens || 0;
      const model = record.message?.model || record.model || 'unknown';
      const timestamp = record.timestamp || '';

      session.totalInput += input;
      session.totalOutput += output;
      session.totalCacheRead += cacheRead;
      session.totalCacheCreate += cacheCreate;

      if (!session.byModel[model]) {
        session.byModel[model] = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
      }
      session.byModel[model].input += input;
      session.byModel[model].output += output;
      session.byModel[model].cacheRead += cacheRead;
      session.byModel[model].cacheCreate += cacheCreate;

      session.messages.push({ timestamp, input, output, cacheRead, cacheCreate, model });
    } catch { /* skip malformed lines */ }
  }

  return session;
}

function estimateCostByModel(byModel) {
  let total = 0;
  for (const [model, counts] of Object.entries(byModel)) {
    const p = getPricing(model);
    total +=
      (counts.input / 1_000_000) * p.input +
      (counts.output / 1_000_000) * p.output +
      (counts.cacheRead / 1_000_000) * p.cache_read +
      (counts.cacheCreate / 1_000_000) * p.cache_create;
  }
  return total;
}

function calcRecent(messages, windowMs) {
  const cutoff = Date.now() - windowMs;
  const totals = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  const recentByModel = {};
  for (const msg of messages) {
    if (new Date(msg.timestamp).getTime() >= cutoff) {
      totals.input += msg.input;
      totals.output += msg.output;
      totals.cacheRead += msg.cacheRead;
      totals.cacheCreate += msg.cacheCreate;
      const m = msg.model || 'unknown';
      if (!recentByModel[m]) recentByModel[m] = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
      recentByModel[m].input += msg.input;
      recentByModel[m].output += msg.output;
      recentByModel[m].cacheRead += msg.cacheRead;
      recentByModel[m].cacheCreate += msg.cacheCreate;
    }
  }
  return { ...totals, cost: estimateCostByModel(recentByModel) };
}

function emptyResult() {
  return {
    totals: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    cost: 0,
    byModel: {},
    hourly: {},
    sessionCount: 0,
    messageCount: 0,
    recent24h: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, cost: 0 },
    sessions: [],
  };
}
