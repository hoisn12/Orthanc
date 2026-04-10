// State
const state = {
  config: null,
  sessions: [],
  events: [],
  subagents: new Map(),
  connected: false,
  tokens: null,
  hideMonitorHooks: false,
  filterPid: null,
  lastActivity: new Map(),
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
    document.getElementById('projectName').textContent = state.config.projectRoot || 'unknown';
    document.getElementById('projectInput').value = state.config.projectRoot || '';
    await fetchSessions();
    await fetchTokenUsage();
  } catch (err) {
    alert(`Failed to switch project: ${err.message}`);
  }
}

// --- Fetch helpers ---

async function fetchConfig() {
  const res = await fetch('/api/config');
  state.config = await res.json();
  renderHarness();
  document.getElementById('projectName').textContent = state.config.projectRoot || 'unknown';
  document.getElementById('projectInput').value = state.config.projectRoot || '';
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
  renderSubagents();
}

// --- SSE ---

function connectSSE() {
  const source = new EventSource('/api/events/stream');
  source.onopen = () => { state.connected = true; updateStatus(); };
  source.onmessage = (e) => {
    const event = JSON.parse(e.data);
    state.events.push(event);
    if (state.events.length > 500) state.events.shift();
    processEvent(event);
    renderFeedItem(event);
    renderSubagents();
    renderSessions();
  };
  source.onerror = () => {
    state.connected = false;
    updateStatus();
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

  // Track last activity per session
  if (pid) {
    state.lastActivity.set(pid, { type, timestamp: event.timestamp });
  }
}

// --- Monitor renderers ---

function updateStatus() {
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  dot.className = state.connected ? 'status-dot' : 'status-dot disconnected';
  text.textContent = state.connected ? 'Live' : 'Disconnected';
}

function renderSessions() {
  const el = document.getElementById('sessions');
  if (state.sessions.length === 0) {
    el.innerHTML = '<span style="color:var(--text-muted);font-size:12px">No active sessions</span>';
    return;
  }
  el.innerHTML = state.sessions.map((s) => {
    const uptime = s.alive && s.uptime ? formatDuration(s.uptime) : 'ended';
    const selected = state.filterPid === s.pid ? ' selected' : '';

    // Running subagents for this session
    const runningAgents = Array.from(state.subagents.values()).filter((a) => a.pid === s.pid && a.status === 'running');
    // Last activity
    const activity = state.lastActivity.get(s.pid);

    let activityHTML = '';
    if (s.alive && (runningAgents.length > 0 || activity)) {
      const parts = [];
      if (runningAgents.length > 0) {
        parts.push(`<span class="session-activity-badge running">${runningAgents.length} agent${runningAgents.length > 1 ? 's' : ''}</span>`);
      }
      if (activity) {
        const ago = formatTimeAgo(activity.timestamp);
        parts.push(`<span class="session-activity-type">${activity.type}</span> <span class="session-activity-ago">${ago}</span>`);
      }
      activityHTML = `<div class="session-activity">${parts.join(' ')}</div>`;
    }

    return `<div class="session-card ${s.alive ? '' : 'dead'}${selected}" data-pid="${s.pid}" style="cursor:pointer">
      <div class="session-pid">${s.alive ? '\u25CF' : '\u25CB'} PID ${s.pid} | ${uptime}</div>
      <div class="session-meta">${s.name} \u2014 ${shortenPath(s.cwd)}</div>
      <div class="session-meta">${s.kind || ''} / ${s.entrypoint || ''}</div>
      ${activityHTML}
    </div>`;
  }).join('');

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
  renderSessions();
  renderFilterBanner();
  renderFeed();
}

function clearSessionFilter() {
  state.filterPid = null;
  renderSessions();
  renderFilterBanner();
  renderFeed();
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
  document.getElementById('feed').innerHTML = filtered.slice().reverse().slice(0, 100).map(eventToHTML).join('');
}

function renderFeedItem(event) {
  if (state.filterPid && event.pid !== state.filterPid) return;
  const el = document.getElementById('feed');
  el.insertAdjacentHTML('afterbegin', eventToHTML(event));
  while (el.children.length > 200) el.removeChild(el.lastChild);
}

function eventToHTML(event) {
  const time = new Date(event.timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const pidLabel = event.pid ? `<span class="event-pid">P${event.pid}</span>` : '';
  return `<div class="event-item">
    <span class="event-time">${time}</span>
    ${pidLabel}
    <span class="event-type">${event.type}</span>
    <span class="event-detail">${extractDetail(event)}</span>
  </div>`;
}

function extractDetail(event) {
  const p = event.payload || {};
  if (p.tool_name) {
    const input = p.tool_input || {};
    if (p.tool_name === 'Bash') return `Bash: ${(input.command || '').slice(0, 60)}`;
    if (p.tool_name === 'Edit' || p.tool_name === 'Write') return `${p.tool_name}: ${input.file_path || ''}`;
    if (p.tool_name === 'Read') return `Read: ${input.file_path || ''}`;
    if (p.tool_name === 'Agent') return `Agent: ${input.subagent_type || ''} \u2014 ${(input.description || '').slice(0, 40)}`;
    return p.tool_name;
  }
  if (p.agent_type) return `${p.agent_type} (${p.agent_id || ''})`;
  if (p.prompt) return (typeof p.prompt === 'string' ? p.prompt : '').slice(0, 80);
  return '';
}

function renderSubagents() {
  const el = document.getElementById('subagents');
  const agents = Array.from(state.subagents.values());
  if (agents.length === 0) {
    el.innerHTML = '<span style="color:var(--text-muted);font-size:12px">Waiting for events...</span>';
    return;
  }
  el.innerHTML = agents.slice().reverse().map((a) => `
    <div class="subagent-item">
      <span class="dot ${a.status}"></span>
      <span>${a.type}</span>
      <span style="color:var(--text-muted)">(${a.model})</span>
      <span style="color:var(--text-secondary)">${a.description}</span>
    </div>
  `).join('');
}

// ============================================================
// File Viewer Modal
// ============================================================

async function openFileViewer(filePath) {
  if (!filePath) return;
  const modal = document.getElementById('fileModal');
  const title = document.getElementById('modalTitle');
  const body = document.getElementById('modalBody');

  title.textContent = filePath;
  body.textContent = 'Loading...';
  modal.style.display = 'flex';

  try {
    const res = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`);
    const data = await res.json();
    if (res.ok) {
      body.textContent = data.content;
    } else {
      body.textContent = `Error: ${data.error}`;
    }
  } catch (err) {
    body.textContent = `Error: ${err.message}`;
  }
}

function initModalHandlers() {
  const modal = document.getElementById('fileModal');
  document.getElementById('modalClose').addEventListener('click', () => { modal.style.display = 'none'; });
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') modal.style.display = 'none'; });
}

// ============================================================
// Harness
// ============================================================

function isMonitorHook(h) {
  return h._marker === '__claude_monitor__';
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

  const sections = [
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
    const target = e.target.closest('[data-file]');
    if (target) openFileViewer(target.dataset.file);
  });

  // Monitor hooks toggle
  const toggleBtn = el.querySelector('#toggleMonitorHooks');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      state.hideMonitorHooks = !state.hideMonitorHooks;
      toggleBtn.textContent = state.hideMonitorHooks ? 'Show monitor hooks' : 'Hide monitor hooks';
      el.querySelectorAll('.hook-flow-row.is-monitor').forEach((row) => {
        row.style.display = state.hideMonitorHooks ? 'none' : '';
      });
    });
  }

  // Hook install/uninstall buttons
  setupHookButtons();
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
  const permCount = (c.permissions?.coreTools?.length || 0) + (c.permissions?.mcpTools?.length || 0)
    + (c.permissions?.webAccess?.length || 0) + (c.permissions?.skills?.length || 0);
  const mcpCount = (c.mcpServers || []).length;
  const mdCount = (c.claudeMdFiles || []).length;

  const stats = [
    { value: c.skills.length, label: 'Skills' },
    { value: c.agents.length, label: 'Agents' },
    { value: (c.rules || []).length, label: 'Rules' },
    { value: hookCount, label: 'Hook Events' },
    { value: permCount, label: 'Permissions' },
    { value: mcpCount, label: 'MCP Servers' },
    { value: mdCount, label: 'CLAUDE.md' },
  ];

  return `<div class="harness-stats">${stats.map((s) =>
    `<div class="harness-stat"><div class="stat-value">${s.value}</div><div class="stat-label">${s.label}</div></div>`
  ).join('')}</div>`;
}

function renderSettingsLayers(c) {
  const layers = c.settingsLayers || [];
  if (layers.length === 0) return '<span style="color:var(--text-muted)">No settings found</span>';

  return layers.map((l, i) => {
    const keysHTML = (keys, label) => keys.length > 0
      ? `<span style="color:var(--text-muted);font-size:11px">${label}:</span> ${keys.map((k) => `<span class="settings-key">${k}</span>`).join(' ')}`
      : '';

    return `<div class="settings-layer depth-${Math.min(i, 2)}" style="--depth:${i}">
      <span class="settings-layer-name">${l.label}</span>
      <div class="settings-layer-keys">
        ${keysHTML(l.settings.keys, 'settings.json')}
        ${l.localSettings.exists ? keysHTML(l.localSettings.keys, 'settings.local.json') : ''}
      </div>
    </div>`;
  }).join('');
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

  return `<div class="mcp-grid">${servers.map((s) => `
    <div class="mcp-card">
      <div class="mcp-card-name">${s.name}</div>
      <div class="mcp-card-tools">${s.tools.length} tools: ${s.tools.map((t) => `<span class="mcp-tool-name">${t}</span>`).join('')}</div>
    </div>
  `).join('')}</div>`;
}

function renderClaudeMd(c) {
  const files = c.claudeMdFiles || [];
  if (files.length === 0) return '<span style="color:var(--text-muted)">No CLAUDE.md files found</span>';

  let depth = 0;
  return `<div class="claude-md-tree">${files.map((f) => {
    const d = f.level === 'parent' ? 0 : f.level === 'project' ? 1 : 2;
    return `<div class="claude-md-node" style="--depth:${d}" data-file="${f.path}">
      <span class="md-level">${f.level}</span>
      <span class="md-path">${shortenPath(f.path)}</span>
      ${f.preview ? `<span class="md-preview">\u2014 ${f.preview}</span>` : ''}
    </div>`;
  }).join('')}</div>`;
}

function renderSkillsAgents(c) {
  const skillsHTML = c.skills.length > 0
    ? c.skills.map((s) => {
        const badges = [];
        if (s.userInvocable) badges.push('<span class="harness-badge badge-invocable">invocable</span>');
        if (s.hasReferences) badges.push('<span class="harness-badge badge-refs">refs</span>');
        if (s.symlink) badges.push(`<span class="harness-badge badge-symlink" title="${s.symlinkTarget || ''}">\u2192 symlink</span>`);
        return `<div class="harness-card" ${s.filePath ? `data-file="${s.filePath}"` : ''}>
          <div class="harness-card-name">
            <span style="width:6px;height:6px;border-radius:50%;background:${s.active ? 'var(--green)' : 'var(--text-muted)'};flex-shrink:0"></span>
            ${s.name}
          </div>
          ${s.description ? `<div class="harness-card-desc">${s.description}</div>` : ''}
          ${badges.length ? `<div class="harness-card-meta">${badges.join('')}</div>` : ''}
        </div>`;
      }).join('')
    : '<span style="color:var(--text-muted)">No skills</span>';

  const agentsHTML = c.agents.length > 0
    ? c.agents.map((a) => {
        const badges = [];
        if (a.symlink) badges.push(`<span class="harness-badge badge-symlink" title="${a.symlinkTarget || ''}">\u2192 symlink</span>`);
        if (a.tools?.length) a.tools.forEach((t) => badges.push(`<span class="harness-badge badge-tool">${t}</span>`));
        return `<div class="harness-card agent-card" ${a.filePath ? `data-file="${a.filePath}"` : ''}>
          <div class="harness-card-name">${a.name}</div>
          ${a.description ? `<div class="harness-card-desc">${a.description}</div>` : ''}
          ${badges.length ? `<div class="harness-card-meta">${badges.join('')}</div>` : ''}
        </div>`;
      }).join('')
    : '<span style="color:var(--text-muted)">No agents</span>';

  return `<div class="harness-2col">
    <div><div class="config-section"><h3>Skills (${c.skills.length})</h3>${skillsHTML}</div></div>
    <div><div class="config-section"><h3>Agents (${c.agents.length})</h3>${agentsHTML}</div></div>
  </div>`;
}

function renderRulesSection(c) {
  const rules = c.rules || [];
  if (rules.length === 0) return '<span style="color:var(--text-muted)">No rules</span>';

  return rules.map((r) => {
    const badges = [];
    if (r.alwaysApply) badges.push('<span class="harness-badge badge-always">always</span>');
    if (r.subRuleCount > 0) badges.push(`<span class="harness-badge badge-refs">${r.subRuleCount} sub-rules</span>`);

    const globsHTML = r.globs.length > 0
      ? `<div class="harness-rule-globs">${r.globs.map((g) => `<span class="glob-tag">${g}</span>`).join('')}</div>`
      : (r.alwaysApply ? '' : '<div class="harness-rule-globs"><span class="glob-tag">always</span></div>');

    return `<div class="harness-rule" ${r.filePath ? `data-file="${r.filePath}"` : ''}>
      <div style="display:flex;align-items:center;gap:6px">
        <span class="harness-rule-name">${r.name}</span>
        ${badges.join('')}
      </div>
      ${r.summary ? `<div class="harness-rule-summary">${r.summary}</div>` : ''}
      ${globsHTML}
    </div>`;
  }).join('');
}

function renderHookFlow(c) {
  const hooks = c.hooks || {};
  const events = Object.keys(hooks);
  if (events.length === 0) return '<span style="color:var(--text-muted)">No hooks</span>';

  const installed = isMonitorInstalled();
  const headerHTML = `<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
    ${installed ? `<span class="hook-status-badge installed">Monitor: Installed</span>` : `<span class="hook-status-badge not-installed">Monitor: Not installed</span>`}
    <div class="harness-hook-actions">
      <button id="installHooksBtn" class="btn-sm btn-install" ${installed ? 'style="display:none"' : ''}>Install Hooks</button>
      <button id="uninstallHooksBtn" class="btn-sm btn-uninstall" ${installed ? '' : 'style="display:none"'}>Uninstall</button>
      <button id="toggleMonitorHooks" class="hook-flow-toggle">${state.hideMonitorHooks ? 'Show monitor hooks' : 'Hide monitor hooks'}</button>
    </div>
  </div>`;

  const flowHTML = events.map((event) => {
    const entries = hooks[event];
    const rows = entries.flatMap((e) =>
      e.hooks.map((h) => {
        const isMon = isMonitorHook(h);
        const label = h.type === 'http'
          ? `http \u2192 ${h.url || ''}`
          : (h.command || '').slice(0, 80) || h.type;
        const hidden = state.hideMonitorHooks && isMon ? ' style="display:none"' : '';
        return `<div class="hook-flow-row${isMon ? ' is-monitor' : ''}"${hidden}>
          <span class="hook-flow-matcher">${e.matcher || '*'}</span>
          <span class="hook-flow-arrow">\u2192</span>
          <span class="hook-flow-action">${label}</span>
          ${e.source ? `<span class="source-tag">${shortenPath(e.source)}</span>` : ''}
        </div>`;
      })
    ).join('');

    return `<div class="hook-flow-event">
      <div class="hook-flow-event-name">${event}</div>
      ${rows}
    </div>`;
  }).join('');

  return headerHTML + flowHTML;
}

function renderEnvSection(c) {
  const entries = Object.entries(c.env || {});
  if (entries.length === 0) return '<span style="color:var(--text-muted)">No environment variables</span>';

  return entries.map(([k, v]) =>
    `<div class="env-row"><span class="env-key">${k}</span> = <span class="env-val">${v}</span></div>`
  ).join('');
}

function setupHookButtons() {
  const installBtn = document.getElementById('installHooksBtn');
  const uninstallBtn = document.getElementById('uninstallHooksBtn');
  if (!installBtn || !uninstallBtn) return;

  installBtn.addEventListener('click', async () => {
    installBtn.disabled = true;
    installBtn.textContent = 'Installing...';
    try {
      const res = await fetch('/api/hooks/install', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        installBtn.textContent = `Installed (${data.installed})`;
        await fetchConfig();
      } else {
        installBtn.textContent = 'Failed';
        alert(data.error);
      }
    } catch (err) {
      installBtn.textContent = 'Failed';
      alert(err.message);
    }
    setTimeout(() => { installBtn.disabled = false; installBtn.textContent = 'Install Hooks'; }, 2000);
  });

  uninstallBtn.addEventListener('click', async () => {
    uninstallBtn.disabled = true;
    uninstallBtn.textContent = 'Removing...';
    try {
      const res = await fetch('/api/hooks/uninstall', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        uninstallBtn.textContent = `Removed (${data.removed})`;
        await fetchConfig();
      } else {
        uninstallBtn.textContent = 'Failed';
        alert(data.error);
      }
    } catch (err) {
      uninstallBtn.textContent = 'Failed';
      alert(err.message);
    }
    setTimeout(() => { uninstallBtn.disabled = false; uninstallBtn.textContent = 'Uninstall'; }, 2000);
  });
}

// ============================================================
// Workflow
// ============================================================

function renderWorkflow() {
  const c = state.config;
  const el = document.getElementById('workflow');
  if (!c) { el.innerHTML = '<span class="wf-empty">No config loaded</span>'; return; }

  const hooks = c.hooks || {};
  const perms = c.permissions || {};
  const rules = c.rules || [];
  const skills = c.skills || [];
  const agents = c.agents || [];

  function hookList(eventName) {
    const entries = hooks[eventName] || [];
    if (entries.length === 0) return '<div class="wf-empty">No hooks</div>';
    return entries.flatMap((e) => (e.hooks || []).map((h) => {
      const isMon = h._marker === '__claude_monitor__';
      const label = h.type === 'http' ? `http \u2192 ${h.url || ''}` : (h.command || '').slice(0, 70) || h.type;
      const matcher = e.matcher && e.matcher !== '*' ? `<span class="wf-pill" style="background:var(--bg-hover);color:var(--accent)">${e.matcher}</span>` : '';
      return `<div class="wf-sidebar-item" ${isMon ? 'style="opacity:0.5"' : ''}>
        <span class="wf-dot" style="background:var(--orange)"></span>
        ${matcher} ${label}${isMon ? ' <span style="color:var(--accent);font-weight:600">[monitor]</span>' : ''}
      </div>`;
    })).join('');
  }

  function permPills() {
    const items = [];
    for (const t of perms.coreTools || []) items.push(`<span class="wf-pill perm-core">${t.name}(${t.pattern})</span>`);
    for (const w of perms.webAccess || []) items.push(`<span class="wf-pill perm-web">${w.type === 'search' ? 'WebSearch' : `WebFetch(${w.constraint})`}</span>`);
    return items.length > 0 ? items.join(' ') : '<span class="wf-empty">No permissions</span>';
  }

  function mcpPills() {
    const servers = c.mcpServers || [];
    if (servers.length === 0) return '';
    return servers.map((s) =>
      `<span class="wf-pill perm-mcp">${s.name} (${s.tools.length})</span>`
    ).join(' ');
  }

  function rulesList() {
    if (rules.length === 0) return '<div class="wf-empty">No rules</div>';
    return rules.slice(0, 8).map((r) => {
      const badges = [];
      if (r.alwaysApply) badges.push('<span class="wf-pill" style="background:rgba(52,211,153,0.15);color:var(--green)">always</span>');
      const globs = r.globs.length > 0 ? r.globs.map((g) => `<span class="wf-pill" style="background:var(--bg-hover);color:var(--text-muted)">${g}</span>`).join(' ') : '';
      return `<div class="wf-sidebar-item">
        <span class="wf-dot" style="background:var(--green)"></span>
        ${r.name.replace('.md', '')} ${badges.join('')} ${globs}
      </div>`;
    }).join('') + (rules.length > 8 ? `<div class="wf-sidebar-item wf-empty">+${rules.length - 8} more</div>` : '');
  }

  function skillAgentBranch() {
    const skillItems = skills.slice(0, 6).map((s) => {
      const badges = [];
      if (s.userInvocable) badges.push('<span class="wf-pill" style="background:rgba(129,140,248,0.2);color:var(--accent)">invocable</span>');
      if (s.symlink) badges.push('<span class="wf-pill" style="background:rgba(251,191,36,0.15);color:var(--yellow)">\u2192</span>');
      return `<div class="wf-sidebar-item"><span class="wf-dot" style="background:var(--accent)"></span>${s.name} ${badges.join('')}</div>`;
    }).join('') + (skills.length > 6 ? `<div class="wf-sidebar-item wf-empty">+${skills.length - 6} more</div>` : '');

    const agentItems = agents.slice(0, 4).map((a) => {
      const toolBadges = (a.tools || []).map((t) => `<span class="wf-pill" style="background:var(--bg-hover);color:var(--text-secondary)">${t}</span>`).join(' ');
      return `<div class="wf-sidebar-item"><span class="wf-dot" style="background:var(--orange)"></span>${a.name} ${toolBadges}</div>`;
    }).join('');

    if (skills.length === 0 && agents.length === 0) return '';
    return `<div class="wf-branch">
      <div class="wf-branch-item">
        <div class="wf-branch-item-title">Skills (${skills.length})</div>
        ${skillItems || '<div class="wf-empty">None</div>'}
      </div>
      <div class="wf-branch-item">
        <div class="wf-branch-item-title">Agents (${agents.length})</div>
        ${agentItems || '<div class="wf-empty">None</div>'}
      </div>
    </div>`;
  }

  function envList() {
    const entries = Object.entries(c.env || {});
    if (entries.length === 0) return '';
    return entries.map(([k, v]) =>
      `<div class="wf-sidebar-item"><span class="wf-dot" style="background:var(--teal)"></span><span style="color:var(--accent)">${k}</span> = ${v}</div>`
    ).join('');
  }

  el.innerHTML = `<div class="wf-pipeline">

    ${stage('stage-prompt', '\u276F', 'User Prompt', 'User submits a prompt to Claude Code')}
    ${arrow()}
    ${stage('stage-hook', '\u26A1', 'UserPromptSubmit Hooks', '', hookList('UserPromptSubmit'))}
    ${arrow()}
    ${stage('stage-rules', '\u2713', 'Rules Applied', `${rules.length} rules loaded based on context`, rulesList())}
    ${arrow()}
    ${stage('stage-perm', '\u26BF', 'Environment & Permissions', '', `
      <div class="wf-sidebar">${permPills()}</div>
      ${mcpPills() ? `<div class="wf-sidebar" style="margin-top:4px">${mcpPills()}</div>` : ''}
      ${envList() ? `<div class="wf-sidebar" style="margin-top:4px">${envList()}</div>` : ''}
    `)}
    ${arrow()}
    ${stage('stage-tool', '\u2692', 'Tool Use', 'Claude decides which tool to use (Bash, Edit, Read, Write, Agent...)', `
      <div class="wf-sidebar">
        ${hookList('PreToolUse') !== '<div class="wf-empty">No hooks</div>'
          ? `<div style="margin-bottom:4px;font-size:10px;color:var(--text-muted);text-transform:uppercase;font-weight:600">PreToolUse Hooks</div>${hookList('PreToolUse')}`
          : ''}
      </div>
    `)}
    ${arrow()}
    ${stage('stage-tool', '\u25B6', 'Execute Tool', 'Tool runs with permission checks applied')}
    ${arrow()}
    ${stage('stage-hook', '\u26A1', 'PostToolUse Hooks', 'Auto-lint, format, validation after tool execution', hookList('PostToolUse'))}
    ${arrow()}
    ${stage('stage-agent', '\u2726', 'Sub-Agent / Skill', 'Claude may spawn sub-agents or invoke skills', `
      ${hookList('SubagentStart') !== '<div class="wf-empty">No hooks</div>'
        ? `<div class="wf-sidebar"><div style="margin-bottom:4px;font-size:10px;color:var(--text-muted);text-transform:uppercase;font-weight:600">SubagentStart Hooks</div>${hookList('SubagentStart')}</div>` : ''}
      ${skillAgentBranch()}
      ${hookList('SubagentStop') !== '<div class="wf-empty">No hooks</div>'
        ? `<div class="wf-sidebar" style="margin-top:6px"><div style="margin-bottom:4px;font-size:10px;color:var(--text-muted);text-transform:uppercase;font-weight:600">SubagentStop Hooks</div>${hookList('SubagentStop')}</div>` : ''}
    `)}
    ${arrow()}
    ${stage('stage-end', '\u25A0', 'Stop / Session End', 'Session completes or is interrupted', `
      <div class="wf-sidebar">
        ${hookList('Stop')}
        ${hookList('SessionEnd') !== '<div class="wf-empty">No hooks</div>'
          ? `<div style="margin-top:4px">${hookList('SessionEnd')}</div>` : ''}
      </div>
    `)}

  </div>`;
}

function stage(cls, icon, title, desc, sidebar) {
  return `<div class="wf-stage ${cls}">
    <div class="wf-stage-header">
      <div class="wf-stage-icon">${icon}</div>
      <div class="wf-stage-title">${title}</div>
    </div>
    ${desc ? `<div class="wf-stage-desc">${desc}</div>` : ''}
    ${sidebar ? `<div class="wf-sidebar">${sidebar}</div>` : ''}
  </div>`;
}

function arrow() {
  return '<div class="wf-arrow">\u25BC</div>';
}

// ============================================================
// Token Usage
// ============================================================

async function fetchTokenUsage() {
  try {
    const res = await fetch('/api/tokens');
    state.tokens = await res.json();
    renderTokenUsage();
  } catch {
    state.tokens = null;
  }
}

function renderTokenUsage() {
  const el = document.getElementById('tokenUsage');
  const t = state.tokens;
  if (!t || t.messageCount === 0) {
    el.innerHTML = '<span style="color:var(--text-muted);font-size:12px">No token data for this project</span>';
    return;
  }

  const total = t.totals.input + t.totals.output + t.totals.cacheRead + t.totals.cacheCreate;
  const pct = (v) => total > 0 ? ((v / total) * 100).toFixed(1) : 0;
  const cacheHitRate = (t.totals.cacheRead + t.totals.input) > 0
    ? ((t.totals.cacheRead / (t.totals.cacheRead + t.totals.input)) * 100).toFixed(1) : 0;

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

  const modelsHTML = Object.entries(t.byModel).map(([model, counts]) => {
    const modelTotal = counts.input + counts.output + counts.cacheRead + counts.cacheCreate;
    return `<div class="token-model-row">
      <span class="token-model-name">${model}</span>
      <span class="token-model-stat">in: ${fmtNum(counts.input)}</span>
      <span class="token-model-stat">out: ${fmtNum(counts.output)}</span>
      <span class="token-model-stat">total: ${fmtNum(modelTotal)}</span>
      <span class="token-model-cost">$${(counts.cost || 0).toFixed(2)}</span>
    </div>`;
  }).join('');

  const sessionsHTML = (t.sessions || []).map((s) => {
    const time = s.startedAt ? new Date(s.startedAt).toLocaleString('en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '\u2014';
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
  }).join('');

  el.innerHTML = cardsHTML + barHTML +
    (modelsHTML ? `<div class="config-section" style="margin-top:10px"><h3>By Model</h3>${modelsHTML}</div>` : '') +
    (sessionsHTML ? `<div class="config-section" style="margin-top:10px"><h3>By Session (${t.sessions.length})</h3>${sessionsHTML}</div>` : '');
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

  if (pageName === 'workflow' && state.config) {
    renderWorkflow();
  }
}

// ============================================================
// Init
// ============================================================

async function init() {
  await fetchConfig();
  await fetchSessions();
  await fetchRecentEvents();
  await fetchTokenUsage();
  connectSSE();

  setInterval(fetchSessions, 5000);
  setInterval(fetchTokenUsage, 30000);

  initModalHandlers();

  // SNB navigation
  document.querySelectorAll('.snb-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      navigateTo(item.dataset.page);
    });
  });

  // Project switch
  const projectInput = document.getElementById('projectInput');
  const projectBtn = document.getElementById('projectBtn');
  projectBtn.addEventListener('click', () => {
    const val = projectInput.value.trim();
    if (val) switchProject(val);
  });
  projectInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const val = projectInput.value.trim();
      if (val) switchProject(val);
    }
  });
}

init();
