import fs from 'node:fs';
import path from 'node:path';

// ── DB-based getTokenUsage (SQL aggregation) ───────────────

export function getTokenUsage(provider, tokenStore, { from, to } = {}) {
  const data = tokenStore.queryAggregated({ from, to });

  if (data.messageCount === 0) return emptyResult();

  // Convert byModel array → object with cost
  const byModelMap = {};
  for (const r of data.byModel) {
    byModelMap[r.model] = {
      input: r.input,
      output: r.output,
      cacheRead: r.cacheRead,
      cacheCreate: r.cacheCreate,
    };
  }
  const cost = estimateCostByModel(provider, byModelMap);

  const byModelWithCost = {};
  for (const [model, counts] of Object.entries(byModelMap)) {
    byModelWithCost[model] = {
      ...counts,
      cost: estimateCostByModel(provider, { [model]: counts }),
    };
  }

  // Build session list with cost
  const sessionList = data.sessions.map((s) => {
    const total = s.input + s.output + s.cacheRead + s.cacheCreate;
    const sessionByModel = {};
    for (const m of s.models) {
      // Per-session model breakdown not available from GROUP BY,
      // use the session total attributed to its models evenly as approximation.
      // For accurate per-session-per-model cost, we'd need a separate query.
      // Instead, compute cost from session totals using the first model.
      sessionByModel[m] = sessionByModel[m] || { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    }
    // Simple cost: attribute all session tokens to its models proportionally
    const sessionCost = s.models.length === 1
      ? estimateCostByModel(provider, { [s.models[0]]: { input: s.input, output: s.output, cacheRead: s.cacheRead, cacheCreate: s.cacheCreate } })
      : estimateCostByModel(provider, { [s.models[0] || 'unknown']: { input: s.input, output: s.output, cacheRead: s.cacheRead, cacheCreate: s.cacheCreate } });

    return {
      sessionId: s.sessionId,
      file: s.file,
      startedAt: s.startedAt,
      lastActivity: s.lastActivity,
      cwd: s.cwd,
      input: s.input,
      output: s.output,
      cacheRead: s.cacheRead,
      cacheCreate: s.cacheCreate,
      total,
      cost: sessionCost,
      messageCount: s.messageCount,
      models: s.models,
    };
  });

  // recent24h with cost
  const recent24hByModelMap = {};
  for (const r of data.recent24hByModel) {
    recent24hByModelMap[r.model] = {
      input: r.input,
      output: r.output,
      cacheRead: r.cacheRead,
      cacheCreate: r.cacheCreate,
    };
  }

  return {
    totals: data.totals,
    cost,
    byModel: byModelWithCost,
    hourly: data.hourly,
    sessionCount: data.sessions.length,
    messageCount: data.messageCount,
    recent24h: { ...data.recent24h, cost: estimateCostByModel(provider, recent24hByModelMap) },
    sessions: sessionList,
  };
}

// ── Helpers exported for token-sync.js ─────────────────────

export function findProjectDir(projectsDir, projectRoot) {
  if (!fs.existsSync(projectsDir)) return null;

  const encoded = projectRoot.replaceAll('/', '-');
  const target = path.join(projectsDir, encoded);
  if (fs.existsSync(target)) return target;

  try {
    const dirs = fs.readdirSync(projectsDir);
    const match = dirs.find((d) => {
      const decoded = d.replaceAll('-', '/');
      return decoded.endsWith(projectRoot) || projectRoot.endsWith(decoded.slice(1));
    });
    if (match) return path.join(projectsDir, match);
  } catch { /* ignore */ }

  return null;
}

export function collectJsonlFiles(dir) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        results.push(full);
      } else if (entry.isDirectory()) {
        results.push(...collectJsonlFiles(full));
      }
    }
  } catch { /* ignore */ }
  return results;
}

// ── Cost calculation ───────────────────────────────────────

function getPricing(provider, model) {
  const pricing = provider.getTokenPricing();
  for (const [key, p] of Object.entries(pricing)) {
    if (model.startsWith(key)) return p;
  }
  return provider.getDefaultPricing();
}

function estimateCostByModel(provider, byModel) {
  let total = 0;
  for (const [model, counts] of Object.entries(byModel)) {
    const p = getPricing(provider, model);
    total +=
      (counts.input / 1_000_000) * p.input +
      (counts.output / 1_000_000) * p.output +
      (counts.cacheRead / 1_000_000) * p.cache_read +
      (counts.cacheCreate / 1_000_000) * p.cache_create;
  }
  return total;
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
