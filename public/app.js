function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// State
const state = {
  config: null,
  sessions: [],
  events: [],
  subagents: new Map(),
  tokens: null,
  filterPid: null,
  lastActivity: new Map(),
  provider: null, // { name, displayName, hookEvents, configDir, available }
  metrics: null, // OTel realtime metrics from /api/metrics
  usage: [], // statusline usage data from /api/usage
  monitorStatus: null, // { hooks, otel, statusline } from /api/hooks/status
  showToolEvents: false, // toggle for pre/post-tool-use in feed
  currentTool: null, // { toolName, detail, pid, timestamp } — currently running tool
  tokenFilter: { preset: 'all', from: null, to: null },
  sessionConfig: null, // per-session config when a session is selected
};

// --- Project switch ---

async function switchProject(projectPath) {
  try {
    const res = await fetch('/api/project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath }),
    });
    if (!res.ok) {
      const err = await res.json();
      alert(`Failed to switch project: ${err.error}`);
      return;
    }
    state.config = await res.json();
    renderHarness();
    await fetchSessions();
    await fetchTokenUsage();
    if (document.getElementById('page-settings')?.classList.contains('active')) {
      await renderSettings();
    }
  } catch (err) {
    alert(`Failed to switch project: ${err.message}`);
  }
}

// --- Fetch helpers ---

async function fetchConfig() {
  const res = await fetch('/api/config');
  state.config = await res.json();
  renderHarness();
}

async function fetchSessions() {
  const res = await fetch('/api/sessions');
  state.sessions = await res.json();
  renderSessions();
}

async function fetchRecentEvents() {
  const res = await fetch('/api/events?limit=100');
  state.events = await res.json();
  state.events.forEach(processEvent);
  renderFeed();
}

// --- SSE ---

function connectSSE() {
  const source = new EventSource('/api/events/stream');
  source.onmessage = (e) => {
    const event = JSON.parse(e.data);
    state.events.push(event);
    if (state.events.length > 500) state.events.shift();
    processEvent(event);
    if (event.type === 'stop' && event.payload?.last_assistant_message) {
      renderFeed(); // Full re-render to remove replaced streaming events
    } else {
      renderFeedItem(event);
    }
    renderSessions();
  };
  source.onerror = () => {
    source.close();
    setTimeout(connectSSE, 3000);
  };
}

function processEvent(event) {
  const type = event.type;
  const payload = event.payload || {};
  const pid = event.pid;

  if (type === 'subagent-start') {
    const id = payload.agent_id || payload.session_id || event.id;
    state.subagents.set(id, {
      id,
      pid,
      type: payload.agent_type || payload.tool_input?.subagent_type || 'unknown',
      model: payload.tool_input?.model || 'default',
      description: payload.tool_input?.description || '',
      status: 'running',
      startedAt: event.timestamp,
    });
  } else if (type === 'subagent-stop') {
    const id = payload.agent_id || payload.session_id;
    if (id && state.subagents.has(id)) state.subagents.get(id).status = 'done';
  }

  // When stop arrives, remove streaming events from the same turn (keep older turns)
  if (type === 'stop' && payload.last_assistant_message && pid) {
    // Find the last user-prompt-submit for this PID to identify the current turn boundary
    let turnStart = 0;
    for (let i = state.events.length - 1; i >= 0; i--) {
      if (state.events[i].type === 'user-prompt-submit' && state.events[i].pid === pid) {
        turnStart = i;
        break;
      }
    }
    state.events = state.events.filter(
      (e, idx) => !(e.type === 'assistant-streaming' && e.pid === pid && idx >= turnStart),
    );
  }

  // Track current running tool (debounced clear to avoid flicker)
  if (type === 'pre-tool-use' || type === 'otel-tool-decision') {
    if (state._clearToolTimer) {
      clearTimeout(state._clearToolTimer);
      state._clearToolTimer = null;
    }
    state.currentTool = {
      toolName: payload.tool_name || payload['tool.name'] || 'unknown',
      detail: extractToolSummary(payload),
      pid,
      timestamp: event.timestamp,
    };
    renderCurrentTool();
  } else if (type === 'post-tool-use' || type === 'otel-tool-result') {
    if (state._clearToolTimer) clearTimeout(state._clearToolTimer);
    state._clearToolTimer = setTimeout(() => {
      state.currentTool = null;
      state._clearToolTimer = null;
      renderCurrentTool();
    }, 500);
  } else if (type === 'otel-api-request') {
    // API call in progress — show model as current activity
    if (state._clearToolTimer) {
      clearTimeout(state._clearToolTimer);
      state._clearToolTimer = null;
    }
    const model = payload.model || payload['gen_ai.request.model'] || '';
    if (model) {
      state.currentTool = { toolName: 'API', detail: model, pid, timestamp: event.timestamp };
      renderCurrentTool();
    }
  } else if (type === 'stop' || type === 'session-end') {
    if (state._clearToolTimer) {
      clearTimeout(state._clearToolTimer);
      state._clearToolTimer = null;
    }
    state.currentTool = null;
    if (pid) state.lastActivity.delete(pid);
    renderCurrentTool();
  }

  // Track last activity per session (except stop/session-end already handled)
  if (pid && type !== 'stop' && type !== 'session-end') {
    const rawDetail = extractDetail(event)
      .replace(/<[^>]*>/g, '')
      .replace(/[\r\n]+/g, ' ')
      .trim();
    state.lastActivity.set(pid, { type, timestamp: event.timestamp, detail: rawDetail });
  }
}

function isToolEvent(type) {
  return type === 'pre-tool-use' || type === 'post-tool-use';
}

function extractToolSummary(payload) {
  const input = payload.tool_input || {};
  const name = payload.tool_name || '';
  let summary = name;
  if (name === 'Bash') summary = (input.command || '').slice(0, 80);
  else if (name === 'Edit' || name === 'Write') summary = input.file_path || '';
  else if (name === 'Read') summary = input.file_path || '';
  else if (name === 'Grep') summary = input.pattern || '';
  else if (name === 'Glob') summary = input.pattern || '';
  else if (name === 'Agent') summary = `${input.subagent_type || ''} \u2014 ${(input.description || '').slice(0, 50)}`;
  return summary.replace(/[\r\n]+/g, ' ').trim();
}

function renderCurrentTool() {
  const el = document.getElementById('currentTool');
  if (!el) return;
  const t = state.currentTool;
  if (t) {
    const pidLabel = t.pid ? `<span class="current-tool-pid">P${t.pid}</span>` : '';
    el.innerHTML = `<div class="current-tool">
      <span class="current-tool-indicator"></span>
      ${pidLabel}
      <span class="current-tool-name">${t.toolName}</span>
      <span class="current-tool-detail">${t.detail}</span>
    </div>`;
    return;
  }

  // No active tool — find most recent activity across all alive sessions
  const aliveSessions = state.sessions.filter((s) => s.alive);
  let best = null;
  for (const s of aliveSessions) {
    const a = state.lastActivity.get(s.pid);
    if (a && (!best || new Date(a.timestamp) > new Date(best.timestamp))) {
      best = { ...a, pid: s.pid };
    }
  }

  if (best) {
    const ago = formatTimeAgo(best.timestamp);
    const detail = best.detail || '';
    el.innerHTML = `<div class="current-tool recent">
      <span class="current-tool-indicator"></span>
      <span class="current-tool-pid">P${best.pid}</span>
      <span class="current-tool-name">${best.type}</span>
      <span class="current-tool-detail">${detail} \u00B7 ${ago}</span>
    </div>`;
    return;
  }

  el.innerHTML = '';
}

// --- Monitor renderers ---

function renderSessions() {
  renderCurrentTool();
  const el = document.getElementById('sessions');
  if (state.sessions.length === 0) {
    el.innerHTML =
      '<div class="panel-title">Active Sessions</div><span style="color:var(--text-muted);font-size:12px">No active sessions</span>';
    return;
  }

  const cards = state.sessions.map((s) => {
    const uptime = s.alive && s.uptime ? formatDuration(s.uptime) : 'ended';
    const selected = state.filterPid === s.pid ? ' selected' : '';

    // Subagents for this session
    const sessionAgents = Array.from(state.subagents.values()).filter((a) => a.pid === s.pid);
    // Last activity
    const activity = state.lastActivity.get(s.pid);

    let activityHTML = '';
    if (s.alive && activity) {
      const ago = formatTimeAgo(activity.timestamp);
      activityHTML = `<div class="session-activity">
        <span class="session-activity-type">${activity.type}</span> <span class="session-activity-ago">${ago}</span>
      </div>`;
    }

    let agentsHTML = '';
    if (sessionAgents.length > 0) {
      agentsHTML = `<div class="session-agents">${sessionAgents
        .slice()
        .reverse()
        .map(
          (a) =>
            `<div class="subagent-item">
          <span class="dot ${a.status}"></span>
          <span>${a.type}</span>
          <span style="color:var(--text-muted)">(${a.model})</span>
          <span style="color:var(--text-secondary)">${a.description}</span>
        </div>`,
        )
        .join('')}</div>`;
    }

    // Consider "working" if last hook/streaming activity within 60s, or statusline data is fresh (within 15s)
    const activityAge = activity ? Date.now() - new Date(activity.timestamp).getTime() : Infinity;
    const u_ = getUsageForSession(s.sessionId);
    const usageAge = u_?._receivedAt ? Date.now() - u_._receivedAt : Infinity;
    const working = s.alive && (activityAge < 60000 || usageAge < 15000);

    // Merge live usage data
    const u = getUsageForSession(s.sessionId);
    let usageHTML = '';
    if (u) {
      const model = u.model?.display_name || u.model?.id || '';
      const cost = u.cost?.total_cost_usd ?? 0;
      const ctx = u.context_window || {};
      const ctxPct = ctx.used_percentage ?? 0;
      const ctxSize = ctx.context_window_size || 0;
      const linesAdded = u.cost?.total_lines_added ?? 0;
      const linesRemoved = u.cost?.total_lines_removed ?? 0;
      const duration = u.cost?.total_duration_ms ?? 0;
      const ctxColor = ctxPct > 80 ? 'var(--red)' : ctxPct > 50 ? 'var(--yellow)' : 'var(--green)';

      usageHTML = `<div class="session-usage">
        <div class="session-usage-stats">
          ${model ? `<span class="session-usage-model">${model}</span>` : ''}
          <span class="session-usage-cost">$${cost.toFixed(4)}</span>
          <span class="session-usage-duration">${formatDuration(duration)}</span>
          <span style="color:var(--green)">+${linesAdded} lines</span>
          <span style="color:var(--red)">-${linesRemoved} lines</span>
        </div>
        <div class="usage-gauge" style="margin-top:4px">
          <div class="usage-gauge-track">
            <div class="usage-gauge-fill" style="width:${Math.min(ctxPct, 100)}%;background:${ctxColor}"></div>
          </div>
          <div class="usage-gauge-label">ctx ${ctxPct}%${ctxSize ? ` (${fmtNum(ctxSize)})` : ''}</div>
        </div>
      </div>`;
    }

    // Token usage from JSONL
    const tk = state.tokens?.sessions?.find((ts) => ts.sessionId === s.sessionId);
    let tokensHTML = '';
    if (tk) {
      tokensHTML = `<div class="session-tokens">
        <span title="Input">in:${fmtNum(tk.input)}</span>
        <span title="Output">out:${fmtNum(tk.output)}</span>
        <span title="Cache Read">cr:${fmtNum(tk.cacheRead)}</span>
        <span title="Total">tot:${fmtNum(tk.total)}</span>
        <span class="session-tokens-cost">$${tk.cost.toFixed(2)}</span>
      </div>`;
    }

    const html = `<div class="session-card ${s.alive ? '' : 'dead'}${selected}" data-pid="${s.pid}" style="cursor:pointer">
      <div class="session-pid${working ? ' working' : ''}">${s.alive ? '\u25CF' : '\u25CB'} PID ${s.pid} | ${uptime}</div>
      <div class="session-meta">${s.name} \u2014 ${shortenPath(s.cwd)}</div>
      <div class="session-meta">${s.kind || ''} / ${s.entrypoint || ''}</div>
      ${activityHTML}
      ${agentsHTML}
      ${usageHTML}
      ${tokensHTML}
    </div>`;

    return { html, working };
  });

  const active = cards.filter((c) => c.working).map((c) => c.html);
  const idle = cards.filter((c) => !c.working).map((c) => c.html);

  let out = '';
  if (active.length > 0) {
    out += `<div class="panel-title">Active Sessions <span class="session-count">${active.length}</span></div>${active.join('')}`;
  }
  if (idle.length > 0) {
    out += `<div class="panel-title" style="margin-top:${active.length > 0 ? '14px' : '0'}">Idle Sessions <span class="session-count">${idle.length}</span></div>${idle.join('')}`;
  }
  if (out === '') {
    out =
      '<div class="panel-title">Active Sessions</div><span style="color:var(--text-muted);font-size:12px">No active sessions</span>';
  }
  el.innerHTML = out;

  el.querySelectorAll('.session-card[data-pid]').forEach((card) => {
    card.addEventListener('click', () => {
      const pid = parseInt(card.dataset.pid);
      if (state.filterPid === pid) {
        clearSessionFilter();
      } else {
        setSessionFilter(pid);
      }
    });
  });
}

function setSessionFilter(pid) {
  state.filterPid = pid;
  state.sessionConfig = null;
  renderSessions();
  renderFilterBanner();
  renderFeed();
  renderSessionConfig();
  fetchSessionConfig(pid);
}

function clearSessionFilter() {
  state.filterPid = null;
  state.sessionConfig = null;
  renderSessions();
  renderFilterBanner();
  renderFeed();
  renderSessionConfig();
}

async function fetchSessionConfig(pid) {
  try {
    const res = await fetch(`/api/sessions/${pid}/config`);
    if (!res.ok) return;
    const config = await res.json();
    if (state.filterPid === pid) {
      state.sessionConfig = config;
      renderSessionConfig();
    }
  } catch {
    /* ignore */
  }
}

function renderSessionConfig() {
  const el = document.getElementById('sessionConfig');
  if (!el) return;
  if (!state.sessionConfig || !state.filterPid) {
    el.innerHTML = '';
    return;
  }

  const cfg = state.sessionConfig;
  let html = `<div class="panel-title" style="margin-top:14px">Session Config <span style="color:var(--text-muted);font-size:11px">${cfg.projectName || ''}</span></div>`;

  // CLAUDE.md files
  const mdFiles = cfg.claudeMdFiles || [];
  if (mdFiles.length > 0) {
    html += `<div class="sc-section"><div class="sc-label">CLAUDE.md</div>`;
    for (const md of mdFiles) {
      const levelBadge = `<span class="sc-badge sc-badge-${md.level}">${md.level}</span>`;
      html += `<div class="sc-card" data-file="${md.path}">
        ${levelBadge} <span class="sc-card-name">${shortenPath(md.path)}</span>
        ${md.preview ? `<span class="sc-card-desc">${md.preview}</span>` : ''}
      </div>`;
    }
    html += `</div>`;
  }

  // Skills
  const skills = (cfg.skills || []).filter((s) => s.active);
  if (skills.length > 0) {
    html += `<div class="sc-section"><div class="sc-label">Skills <span class="sc-count">${skills.length}</span></div>`;
    for (const sk of skills) {
      const badges = [];
      if (sk.userInvocable) badges.push('<span class="sc-badge sc-badge-invoke">invocable</span>');
      if (sk.symlink) badges.push('<span class="sc-badge sc-badge-symlink">symlink</span>');
      html += `<div class="sc-card"${sk.filePath ? ` data-file="${sk.filePath}"` : ''}>
        <span class="sc-card-name">${sk.name}</span> ${badges.join(' ')}
        ${sk.description ? `<span class="sc-card-desc">${sk.description}</span>` : ''}
      </div>`;
    }
    html += `</div>`;
  }

  // Rules
  const rules = cfg.rules || [];
  if (rules.length > 0) {
    html += `<div class="sc-section"><div class="sc-label">Rules <span class="sc-count">${rules.length}</span></div>`;
    for (const r of rules) {
      const badges = [];
      if (r.alwaysApply) badges.push('<span class="sc-badge sc-badge-always">always</span>');
      if (r.globs.length > 0) badges.push(...r.globs.map((g) => `<span class="sc-badge sc-badge-glob">${g}</span>`));
      html += `<div class="sc-card"${r.filePath ? ` data-file="${r.filePath}"` : ''}>
        <span class="sc-card-name">${r.name}</span> ${badges.join(' ')}
        ${r.summary ? `<span class="sc-card-desc">${r.summary}</span>` : ''}
      </div>`;
    }
    html += `</div>`;
  }

  // Agents
  const agents = cfg.agents || [];
  if (agents.length > 0) {
    html += `<div class="sc-section"><div class="sc-label">Agents <span class="sc-count">${agents.length}</span></div>`;
    for (const a of agents) {
      html += `<div class="sc-card"${a.filePath ? ` data-file="${a.filePath}"` : ''}>
        <span class="sc-card-name">${a.name}</span>
        ${a.description ? `<span class="sc-card-desc">${a.description}</span>` : ''}
      </div>`;
    }
    html += `</div>`;
  }

  if (mdFiles.length === 0 && skills.length === 0 && rules.length === 0 && agents.length === 0) {
    html += '<span style="color:var(--text-muted);font-size:12px">No config found for this session\'s project</span>';
  }

  el.innerHTML = html;

  // Click to open file viewer
  el.querySelectorAll('.sc-card[data-file]').forEach((card) => {
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => openFileViewer(card.dataset.file));
  });
}

function renderFilterBanner() {
  let banner = document.getElementById('filterBanner');
  if (!state.filterPid) {
    if (banner) banner.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'filterBanner';
    const feedEl = document.getElementById('feed');
    feedEl.parentNode.insertBefore(banner, feedEl);
  }
  const session = state.sessions.find((s) => s.pid === state.filterPid);
  const label = session ? `PID ${session.pid} (${session.name})` : `PID ${state.filterPid}`;
  banner.className = 'filter-banner';
  banner.innerHTML = `Filtering: <strong>${label}</strong> <button class="btn-sm btn-uninstall" id="clearFilterBtn">\u2715 Clear</button>`;
  document.getElementById('clearFilterBtn').addEventListener('click', clearSessionFilter);
}

function renderFeed() {
  let filtered = state.events;
  if (state.filterPid) {
    filtered = filtered.filter((e) => e.pid === state.filterPid);
  }
  if (!state.showToolEvents) {
    filtered = filtered.filter((e) => !isToolEvent(e.type));
  }
  document.getElementById('feed').innerHTML = filtered.slice().reverse().slice(0, 100).map(eventToHTML).join('');
}

function renderFeedItem(event) {
  if (state.filterPid && event.pid !== state.filterPid) return;
  if (!state.showToolEvents && isToolEvent(event.type)) return;
  const el = document.getElementById('feed');
  el.insertAdjacentHTML('afterbegin', eventToHTML(event));
  while (el.children.length > 200) el.removeChild(el.lastChild);
}

function eventToHTML(event) {
  const time = new Date(event.timestamp).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const pidLabel = event.pid ? `<span class="event-pid">P${event.pid}</span>` : '';
  return `<div class="event-item">
    <span class="event-time">${time}</span>
    ${pidLabel}
    <span class="event-type">${event.type}</span>
    <span class="event-detail">${extractDetail(event)}</span>
  </div>`;
}

function renderMd(text) {
  if (typeof marked !== 'undefined' && marked.parse) {
    return marked.parse(text, { breaks: true });
  }
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
}

function extractDetail(event) {
  const p = event.payload || {};
  const type = event.type;

  // OTel events
  if (type === 'otel-api-request') {
    const model = p.model || p['gen_ai.request.model'] || '';
    const dur = p.duration_ms || p.duration || '';
    const cost = p.cost_usd || p.cost || '';
    return `${model}${dur ? ` ${Math.round(dur)}ms` : ''}${cost ? ` $${Number(cost).toFixed(4)}` : ''}`;
  }
  if (type === 'otel-api-error') {
    const model = p.model || p['gen_ai.request.model'] || '';
    const status = p.status_code || p['http.status_code'] || '';
    const errType = p.error_type || p['error.type'] || '';
    return `${model} ${errType}${status ? ` (${status})` : ''}`;
  }
  if (type === 'otel-tool-result') {
    const tool = p.tool_name || p['tool.name'] || '';
    const dur = p.duration_ms || p.duration || '';
    const ok = p.success !== 'false' && p.success !== false;
    return `${tool}${dur ? ` ${Math.round(dur)}ms` : ''} ${ok ? '\u2713' : '\u2717'}`;
  }
  if (type === 'otel-user-prompt') return 'prompt submitted';
  if (type === 'otel-span') return `${p.name || 'span'} ${p.durationMs ? Math.round(p.durationMs) + 'ms' : ''}`;

  // Assistant streaming from JSONL watcher
  if (type === 'assistant-streaming' && p.text) {
    return `<div class="event-assistant-msg event-md">${renderMd(p.text)}</div>`;
  }

  // Hook events
  if (type === 'stop' && p.last_assistant_message) {
    return `<div class="event-assistant-msg event-md">${renderMd(p.last_assistant_message)}</div>`;
  }
  if (type === 'user-prompt-submit' && p.prompt) {
    const msg = typeof p.prompt === 'string' ? p.prompt : '';
    return `<div class="event-user-msg event-md">${renderMd(msg)}</div>`;
  }
  // Task events
  if (type === 'task-created' && p.task_subject) {
    const team = p.teammate_name ? ` [${p.teammate_name}]` : '';
    return `<span class="event-task">\u2795 ${p.task_subject}${team}</span>`;
  }
  if (type === 'task-completed' && p.task_subject) {
    const team = p.teammate_name ? ` [${p.teammate_name}]` : '';
    return `<span class="event-task done">\u2705 ${p.task_subject}${team}</span>`;
  }

  if (p.tool_name) {
    const input = p.tool_input || {};
    if (p.tool_name === 'Bash') return `Bash: ${input.command || ''}`;
    if (p.tool_name === 'Edit' || p.tool_name === 'Write') return `${p.tool_name}: ${input.file_path || ''}`;
    if (p.tool_name === 'Read') return `Read: ${input.file_path || ''}`;
    if (p.tool_name === 'Agent') return `Agent: ${input.subagent_type || ''} \u2014 ${input.description || ''}`;
    return p.tool_name;
  }
  if (p.agent_type) return `${p.agent_type} (${p.agent_id || ''})`;
  if (p.prompt) return typeof p.prompt === 'string' ? p.prompt : '';
  return '';
}

// ============================================================
// File Viewer / Editor Modal
// ============================================================

const modalState = { filePath: null, type: null, name: null, originalContent: '', editing: false };

async function openFileViewer(filePath, { type, name } = {}) {
  if (!filePath) return;
  const modal = document.getElementById('fileModal');
  const title = document.getElementById('modalTitle');
  const body = document.getElementById('modalBody');
  const editor = document.getElementById('modalEditor');
  const editBtn = document.getElementById('modalEditBtn');
  const saveBtn = document.getElementById('modalSaveBtn');
  const cancelBtn = document.getElementById('modalCancelBtn');
  const fmDiv = document.getElementById('modalFrontmatter');

  modalState.filePath = filePath;
  modalState.type = type || null;
  modalState.name = name || null;
  modalState.editing = false;

  title.textContent = filePath;
  body.textContent = 'Loading...';
  body.style.display = '';
  editor.style.display = 'none';
  editBtn.style.display = 'none';
  saveBtn.style.display = 'none';
  cancelBtn.style.display = 'none';
  fmDiv.style.display = 'none';
  fmDiv.innerHTML = '';
  modal.style.display = 'flex';

  try {
    const res = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`);
    const data = await res.json();
    if (res.ok) {
      body.textContent = data.content;
      modalState.originalContent = data.content;
      editBtn.style.display = '';
    } else {
      body.textContent = `Error: ${data.error}`;
    }
  } catch (err) {
    body.textContent = `Error: ${err.message}`;
  }
}

function enterEditMode() {
  const body = document.getElementById('modalBody');
  const editor = document.getElementById('modalEditor');
  const editBtn = document.getElementById('modalEditBtn');
  const saveBtn = document.getElementById('modalSaveBtn');
  const cancelBtn = document.getElementById('modalCancelBtn');

  editor.value = modalState.originalContent;
  body.style.display = 'none';
  editor.style.display = '';
  editBtn.style.display = 'none';
  saveBtn.style.display = '';
  cancelBtn.style.display = '';
  modalState.editing = true;
  editor.focus();
}

function exitEditMode() {
  const body = document.getElementById('modalBody');
  const editor = document.getElementById('modalEditor');
  const editBtn = document.getElementById('modalEditBtn');
  const saveBtn = document.getElementById('modalSaveBtn');
  const cancelBtn = document.getElementById('modalCancelBtn');

  body.style.display = '';
  editor.style.display = 'none';
  editBtn.style.display = '';
  saveBtn.style.display = 'none';
  cancelBtn.style.display = 'none';
  modalState.editing = false;
}

async function saveModalFile() {
  const editor = document.getElementById('modalEditor');
  const saveBtn = document.getElementById('modalSaveBtn');
  const content = editor.value;

  saveBtn.textContent = 'Saving...';
  saveBtn.disabled = true;

  try {
    let res;
    if (modalState.type === 'skill' && modalState.name) {
      res = await fetch(`/api/skills/${encodeURIComponent(modalState.name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
    } else {
      res = await fetch('/api/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: modalState.filePath, content }),
      });
    }

    const data = await res.json();
    if (res.ok && data.config) {
      state.config = data.config;
      renderHarness();
      modalState.originalContent = content;
      document.getElementById('modalBody').textContent = content;
      exitEditMode();
    } else {
      alert('Save failed: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    alert('Save failed: ' + err.message);
  } finally {
    saveBtn.textContent = 'Save';
    saveBtn.disabled = false;
  }
}

function closeModal() {
  document.getElementById('fileModal').style.display = 'none';
  modalState.editing = false;
}

function initModalHandlers() {
  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('fileModal').addEventListener('click', (e) => { if (e.target.id === 'fileModal') closeModal(); });
  document.getElementById('modalEditBtn').addEventListener('click', enterEditMode);
  document.getElementById('modalSaveBtn').addEventListener('click', saveModalFile);
  document.getElementById('modalCancelBtn').addEventListener('click', exitEditMode);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
}

// ============================================================
// Create Skill Modal
// ============================================================

function openCreateSkillModal() {
  const modal = document.getElementById('createModal');
  const title = document.getElementById('createModalTitle');
  const form = document.getElementById('createForm');
  const editor = document.getElementById('createEditor');

  title.textContent = 'New Skill';
  form.innerHTML = `
    <label>Name <input type="text" id="createSkillName" placeholder="my-skill"></label>
    <label>Description <input type="text" id="createSkillDesc" placeholder="What this skill does"></label>
    <label><input type="checkbox" id="createSkillInvocable"> User invocable</label>
  `;
  editor.value = '';
  editor.style.display = '';
  form.style.display = '';
  modal.style.display = 'flex';

  setTimeout(() => document.getElementById('createSkillName')?.focus(), 50);
}

async function saveCreateSkill() {
  const name = document.getElementById('createSkillName')?.value?.trim();
  const description = document.getElementById('createSkillDesc')?.value?.trim() || '';
  const userInvocable = document.getElementById('createSkillInvocable')?.checked || false;
  const content = document.getElementById('createEditor')?.value || '';
  const btn = document.getElementById('createSaveBtn');

  if (!name) { alert('Name is required'); return; }

  btn.textContent = 'Creating...';
  btn.disabled = true;

  try {
    const res = await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, userInvocable, content }),
    });
    const data = await res.json();
    if (res.ok && data.config) {
      state.config = data.config;
      renderHarness();
      closeCreateModal();
    } else {
      alert('Create failed: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    alert('Create failed: ' + err.message);
  } finally {
    btn.textContent = 'Create';
    btn.disabled = false;
  }
}

function closeCreateModal() {
  document.getElementById('createModal').style.display = 'none';
}

function initCreateModalHandlers() {
  document.getElementById('createSaveBtn').addEventListener('click', saveCreateSkill);
  document.getElementById('createCancelBtn').addEventListener('click', closeCreateModal);
  document.getElementById('createModal').addEventListener('click', (e) => { if (e.target.id === 'createModal') closeCreateModal(); });
}

// ============================================================
// Delete Skill
// ============================================================

async function deleteSkill(name) {
  if (!confirm(`Delete skill "${name}"? This cannot be undone.`)) return;
  try {
    const res = await fetch(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok && data.config) {
      state.config = data.config;
      renderHarness();
    } else {
      alert('Delete failed: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
}

// ============================================================
// Harness
// ============================================================

function isMonitorHook(h) {
  if (h._marker === '__claude_monitor__') return true;
  if (h.type === 'http' && h.url && /^http:\/\/localhost:\d+\/api\/events\//.test(h.url)) return true;
  return false;
}

function isMonitorInstalled() {
  const c = state.config;
  if (!c || !c.hooks) return false;
  for (const entries of Object.values(c.hooks)) {
    for (const entry of entries) {
      if (entry.hooks?.some(isMonitorHook)) return true;
    }
  }
  return false;
}

function renderHarness() {
  const c = state.config;
  if (!c) return;
  const el = document.getElementById('harness');

  const sections = isCodex()
    ? [
        harnessSection('Summary', renderSummaryBar(c), false),
        harnessSection('Settings Layers', renderSettingsLayers(c)),
        harnessSection('Instruction Files', renderClaudeMd(c)),
        harnessSection('Profiles & Plugins', renderProfilesPlugins(c)),
        harnessSection('Hook Flow', renderHookFlow(c)),
        harnessSection('Environment', renderEnvSection(c)),
      ]
    : [
        harnessSection('Summary', renderSummaryBar(c), false),
        harnessSection('Settings Layers', renderSettingsLayers(c)),
        harnessSection('Permissions', renderPermissions(c)),
        harnessSection('MCP Integrations', renderMcpServers(c)),
        harnessSection('CLAUDE.md', renderClaudeMd(c)),
        harnessSection('Skills & Agents', renderSkillsAgents(c)),
        harnessSection('Rules', renderRulesSection(c)),
        harnessSection('Hook Flow', renderHookFlow(c)),
        harnessSection('Environment', renderEnvSection(c)),
      ];

  el.innerHTML = sections.join('');

  // Attach collapse handlers
  el.querySelectorAll('.harness-section-header').forEach((header) => {
    header.addEventListener('click', () => {
      const body = header.nextElementSibling;
      const chevron = header.querySelector('.chevron');
      body.classList.toggle('hidden');
      chevron.classList.toggle('collapsed');
    });
  });

  // Attach file viewer click handlers (event delegation)
  el.addEventListener('click', (e) => {
    // Delete skill button
    const delBtn = e.target.closest('[data-delete-skill]');
    if (delBtn) {
      e.stopPropagation();
      deleteSkill(delBtn.dataset.deleteSkill);
      return;
    }
    // Create skill button
    if (e.target.closest('#btnCreateSkill')) {
      e.stopPropagation();
      openCreateSkillModal();
      return;
    }
    // File viewer with type context
    const target = e.target.closest('[data-file]');
    if (target) {
      openFileViewer(target.dataset.file, {
        type: target.dataset.type || null,
        name: target.dataset.name || null,
      });
    }
  });

}

function harnessSection(title, content, collapsible = true) {
  if (!collapsible) {
    return `<div class="harness-section">${content}</div>`;
  }
  return `<div class="harness-section">
    <div class="harness-section-header">
      <span class="chevron">\u25BC</span>
      <h2>${title}</h2>
    </div>
    <div class="harness-section-body">${content}</div>
  </div>`;
}

function renderSummaryBar(c) {
  const hookCount = Object.keys(c.hooks || {}).length;
  const permCount =
    (c.permissions?.coreTools?.length || 0) +
    (c.permissions?.mcpTools?.length || 0) +
    (c.permissions?.webAccess?.length || 0) +
    (c.permissions?.skills?.length || 0);
  const mcpCount = (c.mcpServers || []).length;
  const mdCount = (c.claudeMdFiles || []).length;

  const stats = isCodex()
    ? [
        { value: (c.profiles || []).length, label: 'Profiles' },
        { value: (c.plugins || []).length, label: 'Plugins' },
        { value: hookCount, label: 'Hook Events' },
        { value: mdCount, label: 'Instruction Files' },
      ]
    : [
        { value: c.skills.length, label: 'Skills' },
        { value: c.agents.length, label: 'Agents' },
        { value: (c.rules || []).length, label: 'Rules' },
        { value: hookCount, label: 'Hook Events' },
        { value: permCount, label: 'Permissions' },
        { value: mcpCount, label: 'MCP Servers' },
        { value: mdCount, label: 'CLAUDE.md' },
      ];

  return `<div class="harness-stats">${stats
    .map(
      (s) =>
        `<div class="harness-stat"><div class="stat-value">${s.value}</div><div class="stat-label">${s.label}</div></div>`,
    )
    .join('')}</div>`;
}

function renderSettingsLayers(c) {
  const layers = c.settingsLayers || [];
  if (layers.length === 0) return '<span style="color:var(--text-muted)">No settings found</span>';

  return layers
    .map((l, i) => {
      const keysHTML = (keys, label) =>
        keys.length > 0
          ? `<span style="color:var(--text-muted);font-size:11px">${label}:</span> ${keys.map((k) => `<span class="settings-key">${k}</span>`).join(' ')}`
          : '';

      return `<div class="settings-layer depth-${Math.min(i, 2)}" style="--depth:${i}">
      <span class="settings-layer-name">${l.label}</span>
      <div class="settings-layer-keys">
        ${keysHTML(l.settings.keys, 'settings.json')}
        ${l.localSettings.exists ? keysHTML(l.localSettings.keys, 'settings.local.json') : ''}
      </div>
    </div>`;
    })
    .join('');
}

function renderPermissions(c) {
  const p = c.permissions || {};
  const groups = [];

  if (p.coreTools?.length) {
    groups.push(`<div class="perm-group"><div class="perm-group-title">Core Tools</div>
      <div class="perm-pills">${p.coreTools.map((t) => `<span class="perm-pill perm-core">${t.name}${t.pattern ? `(${t.pattern})` : ''}</span>`).join('')}</div></div>`);
  }
  if (p.mcpTools?.length) {
    // Group by server
    const byServer = {};
    for (const t of p.mcpTools) {
      if (!byServer[t.server]) byServer[t.server] = [];
      byServer[t.server].push(t.tool);
    }
    for (const [server, tools] of Object.entries(byServer)) {
      const name = server.split('_').pop();
      groups.push(`<div class="perm-group"><div class="perm-group-title">MCP: ${name}</div>
        <div class="perm-pills">${tools.map((t) => `<span class="perm-pill perm-mcp">${t}</span>`).join('')}</div></div>`);
    }
  }
  if (p.webAccess?.length) {
    groups.push(`<div class="perm-group"><div class="perm-group-title">Web Access</div>
      <div class="perm-pills">${p.webAccess.map((w) => `<span class="perm-pill perm-web">${w.type === 'search' ? 'WebSearch' : `WebFetch(${w.constraint})`}</span>`).join('')}</div></div>`);
  }
  if (p.skills?.length) {
    groups.push(`<div class="perm-group"><div class="perm-group-title">Skills</div>
      <div class="perm-pills">${p.skills.map((s) => `<span class="perm-pill perm-skill">Skill(${s.name})</span>`).join('')}</div></div>`);
  }

  return groups.length > 0 ? groups.join('') : '<span style="color:var(--text-muted)">No permissions configured</span>';
}

function renderMcpServers(c) {
  const servers = c.mcpServers || [];
  if (servers.length === 0) return '<span style="color:var(--text-muted)">No MCP servers detected</span>';

  return `<div class="mcp-grid">${servers
    .map(
      (s) => `
    <div class="mcp-card">
      <div class="mcp-card-name">${s.name}</div>
      <div class="mcp-card-tools">${s.tools.length} tools: ${s.tools.map((t) => `<span class="mcp-tool-name">${t}</span>`).join('')}</div>
    </div>
  `,
    )
    .join('')}</div>`;
}

function renderClaudeMd(c) {
  const files = c.claudeMdFiles || [];
  if (files.length === 0) return '<span style="color:var(--text-muted)">No CLAUDE.md files found</span>';

  let depth = 0;
  return `<div class="claude-md-tree">${files
    .map((f) => {
      const d = f.level === 'parent' ? 0 : f.level === 'project' ? 1 : 2;
      return `<div class="claude-md-node" style="--depth:${d}" data-file="${f.path}">
      <span class="md-level">${f.level}</span>
      <span class="md-path">${shortenPath(f.path)}</span>
      ${f.preview ? `<span class="md-preview">\u2014 ${f.preview}</span>` : ''}
    </div>`;
    })
    .join('')}</div>`;
}

function renderSkillsAgents(c) {
  const skillsHTML = c.skills.length > 0
    ? c.skills.map((s) => {
        const badges = [];
        if (s.userInvocable) badges.push('<span class="harness-badge badge-invocable">invocable</span>');
        if (s.hasReferences) badges.push('<span class="harness-badge badge-refs">refs</span>');
        if (s.symlink) badges.push(`<span class="harness-badge badge-symlink" title="${s.symlinkTarget || ''}">\u2192 symlink</span>`);
        const canDelete = !s.symlink;
        return `<div class="harness-card" ${s.filePath ? `data-file="${s.filePath}" data-type="skill" data-name="${s.name}"` : ''}>
          <div class="harness-card-name">
            <span style="width:6px;height:6px;border-radius:50%;background:${s.active ? 'var(--green)' : 'var(--text-muted)'};flex-shrink:0"></span>
            ${s.name}
            ${canDelete ? `<button class="card-delete" data-delete-skill="${s.name}" title="Delete skill">\u2715</button>` : ''}
          </div>
          ${s.description ? `<div class="harness-card-desc">${s.description}</div>` : ''}
          ${badges.length ? `<div class="harness-card-meta">${badges.join('')}</div>` : ''}
        </div>`;
          })
          .join('')
      : '<span style="color:var(--text-muted)">No skills</span>';

  const agentsHTML =
    c.agents.length > 0
      ? c.agents
          .map((a) => {
            const badges = [];
            if (a.symlink)
              badges.push(
                `<span class="harness-badge badge-symlink" title="${a.symlinkTarget || ''}">\u2192 symlink</span>`,
              );
            if (a.tools?.length)
              a.tools.forEach((t) => badges.push(`<span class="harness-badge badge-tool">${t}</span>`));
            return `<div class="harness-card agent-card" ${a.filePath ? `data-file="${a.filePath}"` : ''}>
          <div class="harness-card-name">${a.name}</div>
          ${a.description ? `<div class="harness-card-desc">${a.description}</div>` : ''}
          ${badges.length ? `<div class="harness-card-meta">${badges.join('')}</div>` : ''}
        </div>`;
          })
          .join('')
      : '<span style="color:var(--text-muted)">No agents</span>';

  return `<div class="harness-2col">
    <div><div class="config-section"><h3>Skills (${c.skills.length}) <button class="btn-create" id="btnCreateSkill" title="New skill">+</button></h3>${skillsHTML}</div></div>
    <div><div class="config-section"><h3>Agents (${c.agents.length})</h3>${agentsHTML}</div></div>
  </div>`;
}

function renderProfilesPlugins(c) {
  const profiles = c.profiles || [];
  const plugins = c.plugins || [];

  const profilesHTML =
    profiles.length > 0
      ? profiles
          .map(
            (p) => `<div class="harness-card" ${p.filePath ? `data-file="${p.filePath}"` : ''}>
        <div class="harness-card-name">${p.name}</div>
      </div>`,
          )
          .join('')
      : '<span style="color:var(--text-muted)">No profiles</span>';

  const pluginsHTML =
    plugins.length > 0
      ? plugins
          .map(
            (p) => `<div class="harness-card">
        <div class="harness-card-name">${p.name}</div>
      </div>`,
          )
          .join('')
      : '<span style="color:var(--text-muted)">No plugins</span>';

  return `<div class="harness-2col">
    <div><div class="config-section"><h3>Profiles (${profiles.length})</h3>${profilesHTML}</div></div>
    <div><div class="config-section"><h3>Plugins (${plugins.length})</h3>${pluginsHTML}</div></div>
  </div>`;
}

function renderRulesSection(c) {
  const rules = c.rules || [];
  if (rules.length === 0) return '<span style="color:var(--text-muted)">No rules</span>';

  return rules
    .map((r) => {
      const badges = [];
      if (r.alwaysApply) badges.push('<span class="harness-badge badge-always">always</span>');
      if (r.subRuleCount > 0) badges.push(`<span class="harness-badge badge-refs">${r.subRuleCount} sub-rules</span>`);

      const globsHTML =
        r.globs.length > 0
          ? `<div class="harness-rule-globs">${r.globs.map((g) => `<span class="glob-tag">${g}</span>`).join('')}</div>`
          : r.alwaysApply
            ? ''
            : '<div class="harness-rule-globs"><span class="glob-tag">always</span></div>';

      return `<div class="harness-rule" ${r.filePath ? `data-file="${r.filePath}"` : ''}>
      <div style="display:flex;align-items:center;gap:6px">
        <span class="harness-rule-name">${r.name}</span>
        ${badges.join('')}
      </div>
      ${r.summary ? `<div class="harness-rule-summary">${r.summary}</div>` : ''}
      ${globsHTML}
    </div>`;
    })
    .join('');
}

function renderHookFlow(c) {
  const hooks = c.hooks || {};
  const events = Object.keys(hooks);

  if (events.length === 0) return '<span style="color:var(--text-muted)">No hooks configured</span>';

  const flowHTML = events.map((event) => {
    const entries = hooks[event];
    const rows = entries.flatMap((e) =>
      e.hooks.filter((h) => !isMonitorHook(h)).map((h) => {
        const label = h.type === 'http'
          ? `http \u2192 ${h.url || ''}`
          : (h.command || '').slice(0, 80) || h.type;
        return `<div class="hook-flow-row">
          <span class="hook-flow-matcher">${e.matcher || '*'}</span>
          <span class="hook-flow-arrow">\u2192</span>
          <span class="hook-flow-action">${label}</span>
          ${e.source ? `<span class="source-tag">${shortenPath(e.source)}</span>` : ''}
        </div>`;
          }),
        )
        .join('');

      return `<div class="hook-flow-event">
      <div class="hook-flow-event-name">${event}</div>
      ${rows}
    </div>`;
    })
    .join('');

  return flowHTML;
}

function renderEnvSection(c) {
  const entries = Object.entries(c.env || {});
  if (entries.length === 0) return '<span style="color:var(--text-muted)">No environment variables</span>';

  return entries
    .map(([k, v]) => `<div class="env-row"><span class="env-key">${k}</span> = <span class="env-val">${v}</span></div>`)
    .join('');
}

// ============================================================
// Settings
// ============================================================

async function fetchMonitorStatus() {
  try {
    const res = await fetch('/api/hooks/status');
    state.monitorStatus = await res.json();
  } catch {
    state.monitorStatus = { hooks: false, otel: false, statusline: false };
  }
}

function monitorComponentRow(key, label, desc, installed, isCodexProvider) {
  // Codex doesn't support statusline
  if (key === 'statusline' && isCodexProvider) return '';
  const badge = installed
    ? '<span class="hook-status-badge installed">ON</span>'
    : '<span class="hook-status-badge not-installed">OFF</span>';
  const btn = installed
    ? `<button class="btn-sm btn-uninstall" data-action="uninstall" data-component="${key}">Uninstall</button>`
    : `<button class="btn-sm btn-install" data-action="install" data-component="${key}">Install</button>`;
  return `<div class="settings-component">
    <div class="settings-component-header">
      <span class="settings-component-name">${label}</span>
      ${badge}
    </div>
    <div class="settings-component-desc">${desc}</div>
    <div class="settings-component-actions">${btn}</div>
  </div>`;
}

async function renderSettings() {
  const el = document.getElementById('settings');
  if (!el) return;

  await fetchMonitorStatus();
  const c = state.config;
  const projectPath = c?.projectRoot || '';
  const providerName = state.provider?.displayName || 'Unknown';
  const s = state.monitorStatus || {};
  const isCodexProvider = isCodex();

  el.innerHTML = `
    <div class="settings-page">
      <div class="settings-group">
        <div class="settings-group-title">Project</div>
        <div class="settings-group-body">
          <div class="settings-field">
            <label class="settings-label">Project Path</label>
            <div class="settings-input-row">
              <span class="settings-value" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${projectPath}">${projectPath || 'Not set'}</span>
              <button id="settingsProjectBrowse" class="btn-sm btn-install">Browse...</button>
            </div>
          </div>
          <div class="settings-field">
            <label class="settings-label">Provider</label>
            <span class="settings-value">${providerName}</span>
          </div>
        </div>
      </div>

      <div class="settings-group">
        <div class="settings-group-title">Monitor Components</div>
        <div class="settings-components" id="settingsComponents">
          ${monitorComponentRow(
            'hooks',
            'HTTP Hooks',
            `${HOOK_EVENTS_COUNT} event types \u2014 hook event POST to monitor server`,
            s.hooks,
            isCodexProvider,
          )}
          ${monitorComponentRow(
            'otel',
            'OpenTelemetry',
            'OTLP HTTP/JSON export \u2014 API latency, cost, tool stats',
            s.otel,
            isCodexProvider,
          )}
          ${monitorComponentRow(
            'statusline',
            'Statusline',
            'Realtime usage script \u2014 model, cost, context, rate limits',
            s.statusline,
            isCodexProvider,
          )}
        </div>
        <div class="settings-bulk-actions">
          <button id="settingsInstallAll" class="btn-sm btn-install">Install All</button>
          <button id="settingsUninstallAll" class="btn-sm btn-uninstall">Uninstall All</button>
        </div>
      </div>
    </div>
  `;

  // Project switch via folder picker
  document.getElementById('settingsProjectBrowse').addEventListener('click', () => {
    openFolderPicker(projectPath || '/');
  });

  // Per-component install/uninstall
  el.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action;
      const component = btn.dataset.component;
      btn.disabled = true;
      const origText = btn.textContent;
      btn.textContent = action === 'install' ? 'Installing...' : 'Removing...';
      try {
        const options = { hooks: false, otel: false, statusline: false };
        options[component] = true;
        const endpoint = action === 'install' ? '/api/hooks/install' : '/api/hooks/uninstall';
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(options),
        });
        if (!res.ok) {
          const data = await res.json();
          alert(data.error);
        }
      } catch (err) {
        alert(err.message);
      }
      await fetchConfig();
      await renderSettings();
    });
  });

  // Bulk actions
  document.getElementById('settingsInstallAll').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/hooks/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hooks: true, otel: true, statusline: true }),
      });
      if (!res.ok) {
        const d = await res.json();
        alert(d.error);
      }
    } catch (err) {
      alert(err.message);
    }
    await fetchConfig();
    await renderSettings();
  });

  document.getElementById('settingsUninstallAll').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/hooks/uninstall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hooks: true, otel: true, statusline: true }),
      });
      if (!res.ok) {
        const d = await res.json();
        alert(d.error);
      }
    } catch (err) {
      alert(err.message);
    }
    await fetchConfig();
    await renderSettings();
  });
}

const HOOK_EVENTS_COUNT = 11;

// ============================================================

// ============================================================
// Token Usage
// ============================================================

async function fetchTokenUsage() {
  try {
    const params = new URLSearchParams();
    const { from, to } = state.tokenFilter;
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const qs = params.toString();
    const res = await fetch('/api/tokens' + (qs ? '?' + qs : ''));
    state.tokens = await res.json();
    renderTokenUsage();
    renderSessions();
  } catch {
    state.tokens = null;
  }
}

async function fetchUsage() {
  try {
    const res = await fetch('/api/usage');
    state.usage = await res.json();
    renderLiveUsage();
    renderTokenUsage();
  } catch {
    state.usage = [];
  }
}

async function fetchMetrics() {
  try {
    const res = await fetch('/api/metrics');
    state.metrics = await res.json();
    renderTokenUsage();
  } catch {
    state.metrics = null;
  }
}

function renderDateFilter() {
  const { preset, from, to } = state.tokenFilter;
  const presets = [
    { key: 'all', label: 'All Time' },
    { key: 'today', label: 'Today' },
    { key: '7d', label: '7 Days' },
    { key: '30d', label: '30 Days' },
    { key: 'custom', label: 'Custom' },
  ];
  const buttons = presets
    .map(
      (p) =>
        `<button class="date-preset-btn ${preset === p.key ? 'active' : ''}" data-preset="${p.key}">${p.label}</button>`,
    )
    .join('');

  const startVal = from ? from.slice(0, 10) : '';
  const endVal = to ? to.slice(0, 10) : '';
  const customInputs =
    preset === 'custom'
      ? `
    <div class="date-custom-inputs">
      <input type="date" class="date-filter-input" data-field="from" value="${startVal}" />
      <span class="date-separator">~</span>
      <input type="date" class="date-filter-input" data-field="to" value="${endVal}" />
    </div>`
      : '';

  return `<div class="date-filter-bar">${buttons}${customInputs}</div>`;
}

function applyDatePreset(preset) {
  const today = new Date().toISOString().slice(0, 10);
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

  state.tokenFilter.preset = preset;
  if (preset === 'all') {
    state.tokenFilter.from = null;
    state.tokenFilter.to = null;
  } else if (preset === 'today') {
    state.tokenFilter.from = today + 'T00:00:00.000Z';
    state.tokenFilter.to = today + 'T23:59:59.999Z';
  } else if (preset === '7d') {
    state.tokenFilter.from = daysAgo(7) + 'T00:00:00.000Z';
    state.tokenFilter.to = null;
  } else if (preset === '30d') {
    state.tokenFilter.from = daysAgo(30) + 'T00:00:00.000Z';
    state.tokenFilter.to = null;
  }
  // 'custom' keeps existing values
  fetchTokenUsage();
}

function renderTokenUsage() {
  const el = document.getElementById('tokenUsage');
  const t = state.tokens;
  const filterHTML = renderDateFilter();

  if (!t) {
    el.innerHTML =
      filterHTML + '<span style="color:var(--text-muted);font-size:12px">No token data for this project</span>';
    return;
  }

  const hasOtel = t.realtimeLatency && t.realtimeLatency.count > 0;
  if (t.messageCount === 0 && !hasOtel) {
    el.innerHTML =
      filterHTML + '<span style="color:var(--text-muted);font-size:12px">No token data for this project</span>';
    return;
  }

  if (t.messageCount === 0) {
    el.innerHTML = filterHTML + renderRealtimeMetrics(t);
    return;
  }

  const total = t.totals.input + t.totals.output + t.totals.cacheRead + t.totals.cacheCreate;
  const pct = (v) => (total > 0 ? ((v / total) * 100).toFixed(1) : 0);
  const cacheHitRate =
    t.totals.cacheRead + t.totals.input > 0
      ? ((t.totals.cacheRead / (t.totals.cacheRead + t.totals.input)) * 100).toFixed(1)
      : 0;

  const cardsHTML = `<div class="token-grid">
    <div class="token-card"><div class="label">Total Tokens</div><div class="value">${fmtNum(total)}</div><div class="sub">${t.sessionCount} sessions, ${t.messageCount} messages</div></div>
    <div class="token-card"><div class="label">API Equiv. Cost</div><div class="value cost">$${t.cost.toFixed(2)}</div><div class="sub">24h: $${t.recent24h.cost.toFixed(2)}</div></div>
    <div class="token-card"><div class="label">Input</div><div class="value">${fmtNum(t.totals.input)}</div><div class="sub">24h: ${fmtNum(t.recent24h.input)}</div></div>
    <div class="token-card"><div class="label">Output</div><div class="value">${fmtNum(t.totals.output)}</div><div class="sub">24h: ${fmtNum(t.recent24h.output)}</div></div>
    <div class="token-card"><div class="label">Cache Read</div><div class="value">${fmtNum(t.totals.cacheRead)}</div><div class="sub">24h: ${fmtNum(t.recent24h.cacheRead)}</div></div>
    <div class="token-card"><div class="label">Cache Hit Rate</div><div class="value">${cacheHitRate}%</div><div class="sub">cache create: ${fmtNum(t.totals.cacheCreate)}</div></div>
  </div>`;

  const barHTML = `<div class="token-legend">
    <span class="leg-input">Input (${pct(t.totals.input)}%)</span>
    <span class="leg-output">Output (${pct(t.totals.output)}%)</span>
    <span class="leg-cache-read">Cache Read (${pct(t.totals.cacheRead)}%)</span>
    <span class="leg-cache-create">Cache Create (${pct(t.totals.cacheCreate)}%)</span>
  </div>
  <div class="token-bar">
    <div class="segment seg-input" style="width:${pct(t.totals.input)}%"></div>
    <div class="segment seg-output" style="width:${pct(t.totals.output)}%"></div>
    <div class="segment seg-cache-read" style="width:${pct(t.totals.cacheRead)}%"></div>
    <div class="segment seg-cache-create" style="width:${pct(t.totals.cacheCreate)}%"></div>
  </div>`;

  const modelsHTML = Object.entries(t.byModel)
    .map(([model, counts]) => {
      const modelTotal = counts.input + counts.output + counts.cacheRead + counts.cacheCreate;
      return `<div class="token-model-row">
      <span class="token-model-name">${model}</span>
      <span class="token-model-stat">in: ${fmtNum(counts.input)}</span>
      <span class="token-model-stat">out: ${fmtNum(counts.output)}</span>
      <span class="token-model-stat">total: ${fmtNum(modelTotal)}</span>
      <span class="token-model-cost">$${(counts.cost || 0).toFixed(2)}</span>
    </div>`;
    })
    .join('');

  const sessionsHTML = (t.sessions || [])
    .map((s) => {
      const time = s.startedAt
        ? new Date(s.startedAt).toLocaleString('en-GB', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })
        : '\u2014';
      const id = s.sessionId ? s.sessionId.slice(0, 8) : s.file;
      return `<div class="token-session-row">
      <span class="token-session-id" title="${s.sessionId || s.file}">${id}</span>
      <span class="token-session-time">${time}</span>
      <span class="token-session-stat">in: ${fmtNum(s.input)}</span>
      <span class="token-session-stat">out: ${fmtNum(s.output)}</span>
      <span class="token-session-stat">cache: ${fmtNum(s.cacheRead)}</span>
      <span class="token-session-stat total">${fmtNum(s.total)}</span>
      <span class="token-session-cost">$${s.cost.toFixed(2)}</span>
      <span class="token-session-msgs">${s.messageCount} msgs</span>
      <span class="token-session-model">${s.models.join(', ')}</span>
    </div>`;
    })
    .join('');

  const realtimeHTML = renderRealtimeMetrics(t);

  el.innerHTML =
    filterHTML +
    cardsHTML +
    barHTML +
    realtimeHTML +
    (modelsHTML ? `<div class="config-section" style="margin-top:10px"><h3>By Model</h3>${modelsHTML}</div>` : '') +
    (sessionsHTML
      ? `<div class="config-section" style="margin-top:10px"><h3>By Session (${t.sessions.length})</h3>${sessionsHTML}</div>`
      : '');
}

function renderLiveUsage() {
  renderRateLimits();
  renderSessions();
}

function renderRateLimits() {
  const el = document.getElementById('rateLimits');
  if (!el) return;
  const entries = state.usage || [];
  if (entries.length === 0) {
    el.innerHTML = '';
    return;
  }

  // Aggregate rate limits from all sessions (use most recent)
  const latest = entries[0];
  const rl = latest?.rate_limits || {};
  const rl5h = rl.five_hour;
  const rl7d = rl.seven_day;
  if (!rl5h && !rl7d) {
    el.innerHTML = '';
    return;
  }

  const gauges = [];
  if (rl5h) {
    const pct5 = rl5h.used_percentage ?? 0;
    const color5 = pct5 > 80 ? 'var(--red)' : pct5 > 50 ? 'var(--yellow)' : 'var(--accent)';
    const reset5 = rl5h.resets_at ? formatTimeUntil(rl5h.resets_at * 1000) : '';
    gauges.push(`<div class="usage-rl-row">
      <span class="usage-rl-label">5h</span>
      <div class="usage-gauge-track"><div class="usage-gauge-fill" style="width:${Math.min(pct5, 100)}%;background:${color5}"></div></div>
      <span class="usage-rl-pct">${pct5.toFixed(1)}%</span>
      <span class="usage-rl-reset">${reset5 ? `resets ${reset5}` : ''}</span>
    </div>`);
  }
  if (rl7d) {
    const pct7 = rl7d.used_percentage ?? 0;
    const color7 = pct7 > 80 ? 'var(--red)' : pct7 > 50 ? 'var(--yellow)' : 'var(--accent)';
    const reset7 = rl7d.resets_at ? formatTimeUntil(rl7d.resets_at * 1000) : '';
    gauges.push(`<div class="usage-rl-row">
      <span class="usage-rl-label">7d</span>
      <div class="usage-gauge-track"><div class="usage-gauge-fill" style="width:${Math.min(pct7, 100)}%;background:${color7}"></div></div>
      <span class="usage-rl-pct">${pct7.toFixed(1)}%</span>
      <span class="usage-rl-reset">${reset7 ? `resets ${reset7}` : ''}</span>
    </div>`);
  }

  el.innerHTML = `<div class="usage-subsection" style="margin-bottom:12px">
    <div class="panel-title">Rate Limits</div>
    ${gauges.join('')}
  </div>`;
}

function getUsageForSession(sessionId) {
  if (!sessionId || !state.usage) return null;
  return state.usage.find((u) => u.session_id === sessionId) || null;
}

function formatTimeUntil(targetMs) {
  const diff = targetMs - Date.now();
  if (diff <= 0) return 'now';
  const m = Math.floor(diff / 60000);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h ${m % 60}m`;
  return `in ${Math.floor(h / 24)}d`;
}

function renderRealtimeMetrics(t) {
  const m = state.metrics;
  const lat = t.realtimeLatency;
  const hasLatency = lat && lat.count > 0;
  const hasMetrics =
    m &&
    (hasLatency ||
      Object.keys(m.modelBreakdown || {}).length > 0 ||
      Object.keys(m.toolStats || {}).length > 0 ||
      (m.errorRate?.total || 0) > 0);

  if (!hasMetrics) return '';

  // --- Latency bars ---
  let latencyHTML = '';
  if (hasLatency) {
    latencyHTML = `<div class="rt-card">
      <div class="rt-card-title">API Latency</div>
      <div class="rt-latency-bars">
        <div class="rt-bar-group">
          <div class="rt-bar-label">p50</div>
          <div class="rt-bar-track"><div class="rt-bar-fill rt-p50" style="width:${barWidth(lat.p50, lat.p99)}%"></div></div>
          <div class="rt-bar-value">${fmtMs(lat.p50)}</div>
        </div>
        <div class="rt-bar-group">
          <div class="rt-bar-label">p95</div>
          <div class="rt-bar-track"><div class="rt-bar-fill rt-p95" style="width:${barWidth(lat.p95, lat.p99)}%"></div></div>
          <div class="rt-bar-value">${fmtMs(lat.p95)}</div>
        </div>
        <div class="rt-bar-group">
          <div class="rt-bar-label">p99</div>
          <div class="rt-bar-track"><div class="rt-bar-fill rt-p99" style="width:100%"></div></div>
          <div class="rt-bar-value">${fmtMs(lat.p99)}</div>
        </div>
      </div>
      <div class="rt-latency-summary">${lat.count} calls, avg ${fmtMs(lat.avg)}</div>
    </div>`;
  }

  // --- Cost/min chart ---
  const timeline = t.realtime || [];
  let costChartHTML = '';
  if (timeline.length > 0) {
    const maxCost = Math.max(...timeline.map((b) => b.cost), 0.001);
    const bars = timeline
      .slice(-30)
      .map((b) => {
        const h = Math.max(2, (b.cost / maxCost) * 40);
        const time = new Date(b.timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        return `<div class="rt-cost-bar" title="${time}: $${b.cost.toFixed(4)}" style="height:${h}px"></div>`;
      })
      .join('');
    costChartHTML = `<div class="rt-card">
      <div class="rt-card-title">Cost / min</div>
      <div class="rt-cost-bars">${bars}</div>
      <div class="rt-cost-label">last ${timeline.length} min</div>
    </div>`;
  }

  // --- Model breakdown ---
  const models = m?.modelBreakdown || {};
  let modelHTML = '';
  if (Object.keys(models).length > 0) {
    const rows = Object.entries(models)
      .map(([name, d]) => {
        const shortName = name.replace(/^claude-/, '').replace(/^gpt-/, '');
        return `<div class="rt-table-row">
        <span class="rt-table-name">${shortName}</span>
        <span class="rt-table-stat">${d.calls} calls</span>
        <span class="rt-table-stat">${fmtMs(d.avgLatency)} avg</span>
        <span class="rt-table-stat">${fmtNum(d.totalTokens)} tok</span>
        <span class="rt-table-cost">$${d.totalCost.toFixed(4)}</span>
      </div>`;
      })
      .join('');
    modelHTML = `<div class="rt-card">
      <div class="rt-card-title">Model Breakdown</div>
      ${rows}
    </div>`;
  }

  // --- Tool stats ---
  const tools = m?.toolStats || {};
  let toolHTML = '';
  if (Object.keys(tools).length > 0) {
    const rows = Object.entries(tools)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10)
      .map(([name, d]) => {
        const errPct = (d.errorRate * 100).toFixed(0);
        const errClass = d.errorRate > 0.1 ? ' rt-err-high' : d.errorRate > 0 ? ' rt-err-warn' : '';
        return `<div class="rt-table-row">
          <span class="rt-table-name">${name}</span>
          <span class="rt-table-stat">${d.count}x</span>
          <span class="rt-table-stat">${fmtMs(d.avg)} avg</span>
          <span class="rt-table-stat">${fmtMs(d.p95)} p95</span>
          <span class="rt-table-stat${errClass}">${errPct}% err</span>
        </div>`;
      })
      .join('');
    toolHTML = `<div class="rt-card">
      <div class="rt-card-title">Tool Performance</div>
      ${rows}
    </div>`;
  }

  // --- Error rate ---
  const errors = m?.errorRate || {};
  let errorHTML = '';
  if (errors.total > 0) {
    const rows = Object.entries(errors.byType)
      .sort((a, b) => b[1] - a[1])
      .map(
        ([type, count]) => `<div class="rt-table-row">
        <span class="rt-table-name rt-err-type">${type}</span>
        <span class="rt-table-stat">${count}x</span>
      </div>`,
      )
      .join('');
    errorHTML = `<div class="rt-card rt-card-error">
      <div class="rt-card-title">API Errors <span class="rt-err-badge">${errors.total}</span></div>
      ${rows}
    </div>`;
  }

  return `<div class="config-section" style="margin-top:10px">
    <h3>Realtime API Metrics <span class="rt-badge">OTel</span></h3>
    <div class="rt-dashboard">${latencyHTML}${costChartHTML}${modelHTML}${toolHTML}${errorHTML}</div>
  </div>`;
}

function fmtMs(ms) {
  if (ms >= 1000) return (ms / 1000).toFixed(1) + 's';
  return Math.round(ms) + 'ms';
}

function barWidth(value, max) {
  return max > 0 ? Math.round((value / max) * 100) : 0;
}

function fmtNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

// ============================================================
// Utilities
// ============================================================

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatTimeAgo(timestamp) {
  const diff = Date.now() - new Date(timestamp).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function shortenPath(p) {
  if (!p) return '';
  const parts = p.split('/');
  if (parts.length <= 4) return p;
  return '\u2026/' + parts.slice(-3).join('/');
}

// ============================================================
// Page Navigation
// ============================================================

function navigateTo(pageName) {
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  document.querySelectorAll('.snb-item').forEach((n) => n.classList.remove('active'));
  const page = document.getElementById(`page-${pageName}`);
  const nav = document.querySelector(`.snb-item[data-page="${pageName}"]`);
  if (page) page.classList.add('active');
  if (nav) nav.classList.add('active');

  if (pageName === 'settings') {
    renderSettings();
  }
}

// ============================================================
// Init
// ============================================================

async function fetchProvider() {
  try {
    const res = await fetch('/api/provider');
    state.provider = await res.json();
  } catch {
    /* ignore */
  }
}

function isCodex() {
  return state.provider?.name === 'codex';
}

async function init() {
  await fetchProvider();
  await fetchConfig();
  await fetchSessions();
  await fetchRecentEvents();
  await fetchTokenUsage();
  await fetchMetrics();
  await fetchUsage();
  connectSSE();

  setInterval(fetchSessions, 5000);
  setInterval(fetchTokenUsage, 30000);
  setInterval(fetchMetrics, 15000);
  setInterval(fetchUsage, 10000);

  initModalHandlers();
  initCreateModalHandlers();

  // Tool events toggle
  document.getElementById('toggleToolEvents').addEventListener('click', (e) => {
    state.showToolEvents = !state.showToolEvents;
    e.target.textContent = state.showToolEvents ? 'Hide tool events' : 'Show tool events';
    renderFeed();
  });

  // SNB navigation
  document.querySelectorAll('.snb-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      navigateTo(item.dataset.page);
    });
  });

  // Date filter event delegation
  document.getElementById('tokenUsage').addEventListener('click', (e) => {
    const btn = e.target.closest('.date-preset-btn');
    if (btn) applyDatePreset(btn.dataset.preset);
  });
  document.getElementById('tokenUsage').addEventListener('change', (e) => {
    if (e.target.classList.contains('date-filter-input')) {
      state.tokenFilter.preset = 'custom';
      const fromInput = document.querySelector('.date-filter-input[data-field="from"]');
      const toInput = document.querySelector('.date-filter-input[data-field="to"]');
      state.tokenFilter.from = fromInput?.value ? fromInput.value + 'T00:00:00.000Z' : null;
      state.tokenFilter.to = toInput?.value ? toInput.value + 'T23:59:59.999Z' : null;
      fetchTokenUsage();
    }
  });
}

init();
