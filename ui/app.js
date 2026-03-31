/* ═══════════════════════════════════════════════════════
   LLM Hub — Frontend SPA Application
   ═══════════════════════════════════════════════════════ */

const API_BASE = '/api';

// ── State ──────────────────────────────────────────────
let currentPage = 'hub';
let servers = [];
let agents = [];

// ── Router ─────────────────────────────────────────────
function navigate(page) {
    currentPage = page;
    document.querySelectorAll('.nav-item').forEach(el => {
        el.classList.toggle('active', el.dataset.page === page);
    });
    render();
}

function initRouter() {
    window.addEventListener('hashchange', () => {
        const page = location.hash.replace('#', '') || 'hub';
        navigate(page);
    });
    const initial = location.hash.replace('#', '') || 'hub';
    navigate(initial);
}

// ── API Layer ──────────────────────────────────────────
async function apiGet(path) {
    const res = await fetch(`${API_BASE}${path}`);
    if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail || 'Request failed');
    }
    return res.json();
}

async function apiPost(path, body = null) {
    const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${API_BASE}${path}`, opts);
    if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail || 'Request failed');
    }
    return res.json();
}

async function apiPut(path, body) {
    const res = await fetch(`${API_BASE}${path}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail || 'Request failed');
    }
    return res.json();
}

async function apiDelete(path) {
    const res = await fetch(`${API_BASE}${path}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail || 'Request failed');
    }
}

// ── Data Fetching ──────────────────────────────────────
async function fetchServers() {
    try {
        servers = await apiGet('/configs');
    } catch (e) {
        showToast('Failed to fetch servers: ' + e.message, 'error');
        servers = [];
    }
}

async function fetchAgents() {
    try {
        agents = await apiGet('/agents');
    } catch (e) {
        agents = [];
    }
}

// ── Render ─────────────────────────────────────────────
async function render() {
    await Promise.all([fetchServers(), fetchAgents()]);
    const main = document.getElementById('main-content');
    if (currentPage === 'hub') {
        main.innerHTML = renderHubPage();
        bindHubEvents();
    } else if (currentPage === 'configs') {
        main.innerHTML = renderConfigsPage();
        bindConfigsEvents();
    } else if (currentPage === 'agents') {
        main.innerHTML = renderAgentPage();
        bindAgentEvents();
    } else if (currentPage === 'terminal') {
        main.innerHTML = renderTerminalPage();
        bindTerminalEvents();
    } else if (currentPage === 'chat') {
        main.innerHTML = renderChatPage();
        bindChatEvents();
    }
}

// ── Hub Page ───────────────────────────────────────────
function renderHubPage() {
    if (servers.length === 0) {
        return `
            <div class="page-header">
                <div>
                    <h1>Server Hub</h1>
                    <p class="subtitle">Monitor and control your llama.cpp servers</p>
                </div>
            </div>
            <div class="empty-state">
                <div class="empty-state-icon">
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <rect x="4" y="4" width="16" height="16" rx="2"/>
                        <rect x="9" y="9" width="6" height="6"/>
                        <line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/>
                        <line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/>
                    </svg>
                </div>
                <h3>No Servers Configured</h3>
                <p>Create your first server configuration to get started managing llama.cpp instances.</p>
                <a href="#configs" class="btn btn-primary">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                    Create Configuration
                </a>
            </div>`;
    }

    const cards = servers.map(s => {
        const c = s.config;
        const running = s.running;
        const statusClass = running ? 'running' : 'stopped';
        const statusText = running ? 'Running' : 'Stopped';
        const modelName = c.model_path.split('/').pop();

        return `
            <div class="server-card ${statusClass}" data-id="${c.id}">
                <div class="card-header">
                    <div class="card-title">${escapeHtml(c.name)}</div>
                    <div class="card-status ${statusClass}">
                        <span class="status-dot"></span>
                        ${statusText}
                    </div>
                </div>
                <div class="card-details">
                    <div class="card-detail">
                        <span class="label">Model</span>
                        <span class="value" title="${escapeHtml(c.model_path)}">${escapeHtml(modelName)}</span>
                    </div>
                    <div class="card-detail">
                        <span class="label">Address</span>
                        <span class="value mono">${escapeHtml(c.host)}:${c.port}</span>
                    </div>
                    <div class="card-detail">
                        <span class="label">GPU</span>
                        <span class="value">${c.n_gpu_layers === -1 ? 'All layers' : c.n_gpu_layers + ' layers'}</span>
                    </div>
                    <div class="card-detail">
                        <span class="label">Context</span>
                        <span class="value">${c.ctx_size.toLocaleString()} tokens</span>
                    </div>
                </div>
                <div class="card-actions">
                    ${running
                ? `<button class="btn btn-danger btn-sm stop-btn" data-id="${c.id}">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
                            Stop Server
                           </button>`
                : `<button class="btn btn-primary btn-sm start-btn" data-id="${c.id}">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg>
                            Start Server
                           </button>`
            }
                </div>
            </div>`;
    }).join('');

    return `
        <div class="page-header">
            <div>
                <h1>Server Hub</h1>
                <p class="subtitle">Monitor and control your llama.cpp servers</p>
            </div>
        </div>
        <div class="server-grid">${cards}</div>`;
}

function bindHubEvents() {
    document.querySelectorAll('.start-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            btn.disabled = true;
            btn.textContent = 'Starting…';
            try {
                await apiPost(`/configs/${id}/start`);
                showToast('Server started successfully', 'success');
            } catch (e) {
                showToast('Failed to start: ' + e.message, 'error');
            }
            render();
        });
    });

    document.querySelectorAll('.stop-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            btn.disabled = true;
            btn.textContent = 'Stopping…';
            try {
                await apiPost(`/configs/${id}/stop`);
                showToast('Server stopped', 'info');
            } catch (e) {
                showToast('Failed to stop: ' + e.message, 'error');
            }
            render();
        });
    });
}

// ── Configs Page ───────────────────────────────────────
function renderConfigsPage() {
    const header = `
        <div class="page-header">
            <div>
                <h1>Configurations</h1>
                <p class="subtitle">Create and manage server configurations</p>
            </div>
            <button class="btn btn-primary" id="new-config-btn">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
                New Config
            </button>
        </div>`;

    if (servers.length === 0) {
        return header + `
            <div class="empty-state">
                <div class="empty-state-icon">
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <circle cx="12" cy="12" r="3"/>
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                    </svg>
                </div>
                <h3>No Configurations Yet</h3>
                <p>Click "New Config" to create a server configuration for your llama.cpp models.</p>
            </div>`;
    }

    const items = servers.map(s => {
        const c = s.config;
        const modelName = c.model_path.split('/').pop();
        const statusLabel = s.running ? '<span style="color:var(--status-running)">● Running</span>' : '';

        return `
            <div class="config-item" data-id="${c.id}">
                <div class="config-item-info">
                    <div class="config-item-name">${escapeHtml(c.name)} ${statusLabel}</div>
                    <div class="config-item-meta">
                        <span title="${escapeHtml(c.model_path)}">${escapeHtml(modelName)}</span>
                        <span>${c.host}:${c.port}</span>
                        <span>GPU: ${c.n_gpu_layers === -1 ? 'All' : c.n_gpu_layers}</span>
                        <span>Ctx: ${c.ctx_size.toLocaleString()}</span>
                    </div>
                </div>
                <div class="config-item-actions">
                    <button class="btn btn-ghost btn-sm edit-btn" data-id="${c.id}" ${s.running ? 'disabled title="Stop server first"' : ''}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                        </svg>
                        Edit
                    </button>
                    <button class="btn btn-danger btn-sm delete-btn" data-id="${c.id}" data-name="${escapeHtml(c.name)}" ${s.running ? 'disabled title="Stop server first"' : ''}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                        </svg>
                        Delete
                    </button>
                </div>
            </div>`;
    }).join('');

    return header + `<div class="config-list">${items}</div>`;
}

function bindConfigsEvents() {
    document.getElementById('new-config-btn')?.addEventListener('click', () => openModal());

    document.querySelectorAll('.edit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.dataset.id;
            const server = servers.find(s => s.config.id === id);
            if (server) openModal(server.config);
        });
    });

    document.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.dataset.id;
            const name = btn.dataset.name;
            showConfirm(`Delete "${name}"?`, 'This action cannot be undone.', async () => {
                try {
                    await apiDelete(`/configs/${id}`);
                    showToast('Configuration deleted', 'info');
                    render();
                } catch (e) {
                    showToast('Failed to delete: ' + e.message, 'error');
                }
            });
        });
    });
}

// ── Agent Page ─────────────────────────────────────────
function renderAgentPage() {
    const header = `
        <div class="page-header">
            <div>
                <h1>Agents</h1>
                <p class="subtitle">Configure KHarness agents with tools and personalities</p>
            </div>
            <button class="btn btn-primary" id="new-agent-btn">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
                New Agent
            </button>
        </div>`;

    if (agents.length === 0) {
        return header + `
            <div class="empty-state">
                <div class="empty-state-icon">
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <circle cx="12" cy="8" r="4"/>
                        <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
                    </svg>
                </div>
                <h3>No Agents Yet</h3>
                <p>Click "New Agent" to create a KHarness agent with tools and a soul.</p>
            </div>`;
    }

    const items = agents.map(a => {
        const toolCount = a.tools.length;
        const soulName = a.soul_md_path ? a.soul_md_path.split('/').pop() : 'No soul file';
        return `
            <div class="config-item" data-id="${a.id}">
                <div class="config-item-info">
                    <div class="config-item-name">${escapeHtml(a.name)}</div>
                    <div class="config-item-meta">
                        <span>${toolCount} tool${toolCount !== 1 ? 's' : ''}</span>
                        <span title="${escapeHtml(a.soul_md_path || '')}">${escapeHtml(soulName)}</span>
                    </div>
                </div>
                <div class="config-item-actions">
                    <button class="btn btn-ghost btn-sm agent-edit-btn" data-id="${a.id}">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                        </svg>
                        Edit
                    </button>
                    <button class="btn btn-danger btn-sm agent-delete-btn" data-id="${a.id}" data-name="${escapeHtml(a.name)}">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                        </svg>
                        Delete
                    </button>
                </div>
            </div>`;
    }).join('');

    return header + `<div class="config-list">${items}</div>`;
}

function bindAgentEvents() {
    document.getElementById('new-agent-btn')?.addEventListener('click', () => openAgentModal());

    document.querySelectorAll('.agent-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const agent = agents.find(a => a.id === btn.dataset.id);
            if (agent) openAgentModal(agent);
        });
    });

    document.querySelectorAll('.agent-delete-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.dataset.id;
            const name = btn.dataset.name;
            showConfirm(`Delete "${name}"?`, 'This action cannot be undone.', async () => {
                try {
                    await apiDelete(`/agents/${id}`);
                    showToast('Agent deleted', 'info');
                    render();
                } catch (e) {
                    showToast('Failed to delete agent: ' + e.message, 'error');
                }
            });
        });
    });
}

function openAgentModal(agent = null) {
    const modal = document.getElementById('agent-modal');
    document.getElementById('agent-modal-title').textContent = agent ? 'Edit Agent' : 'New Agent';
    document.getElementById('agent-id').value = agent?.id || '';
    document.getElementById('agent-name').value = agent?.name || '';
    document.getElementById('agent-soul-path').value = agent?.soul_md_path || '';

    // Reset all checkboxes, then check the ones in agent.tools
    document.querySelectorAll('#agent-form input[name="tool"]').forEach(cb => {
        cb.checked = agent ? agent.tools.includes(cb.value) : false;
    });

    modal.classList.add('open');
}

function closeAgentModal() {
    document.getElementById('agent-modal').classList.remove('open');
}

// ── Terminal Page ──────────────────────────────────────
let terminalPoller = null;
let currentTerminalServerId = null;
let currentTerminalOffset = 0;

function renderTerminalPage() {
    // Stop any existing poller
    stopTerminalPoller();

    const header = `
        <div class="page-header">
            <div>
                <h1>Server Terminal</h1>
                <p class="subtitle">View live stdout and stderr from your llama-server instances</p>
            </div>
        </div>`;

    if (servers.length === 0) {
        return header + `
            <div class="empty-state">
                <div class="empty-state-icon">
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <polyline points="4 17 10 11 4 5"/>
                        <line x1="12" y1="19" x2="20" y2="19"/>
                    </svg>
                </div>
                <h3>No Configurations</h3>
                <p>Create a server configuration first to view terminal output.</p>
                <a href="#configs" class="btn btn-primary">Go to Configs</a>
            </div>`;
    }

    const options = servers.map(s => {
        const c = s.config;
        return `<option value="${c.id}">${escapeHtml(c.name)}</option>`;
    }).join('');

    return header + `
        <div class="terminal-container">
            <div class="terminal-header">
                <select class="terminal-selector" id="terminal-server-select">
                    ${options}
                </select>
                <div class="terminal-status-badge stopped" id="terminal-status">
                    <span class="status-dot"></span> <span id="terminal-status-text">Stopped</span>
                </div>
                <button class="btn btn-ghost btn-sm" id="terminal-clear-btn">Clear Output</button>
            </div>
            <div class="terminal-window" id="terminal-window">
                <div class="terminal-empty">Select a server to view output</div>
            </div>
        </div>`;
}

function bindTerminalEvents() {
    const select = document.getElementById('terminal-server-select');
    if (!select) return;

    select.addEventListener('change', (e) => {
        switchTerminalServer(e.target.value);
    });

    document.getElementById('terminal-clear-btn')?.addEventListener('click', () => {
        const win = document.getElementById('terminal-window');
        if (win) win.innerHTML = '';
        currentTerminalOffset = 0; // The backend keeps the lines, but we clear our view
    });

    // Start with the first option
    if (servers.length > 0) {
        select.value = servers[0].config.id;
        switchTerminalServer(servers[0].config.id);
    }
}

function switchTerminalServer(serverId) {
    currentTerminalServerId = serverId;
    currentTerminalOffset = 0;

    const win = document.getElementById('terminal-window');
    if (win) win.innerHTML = '';

    stopTerminalPoller();
    pollTerminalOutput();
    terminalPoller = setInterval(pollTerminalOutput, 1000);
}

function stopTerminalPoller() {
    if (terminalPoller) {
        clearInterval(terminalPoller);
        terminalPoller = null;
    }
}

async function pollTerminalOutput() {
    if (currentPage !== 'terminal' || !currentTerminalServerId) {
        stopTerminalPoller();
        return;
    }

    try {
        const data = await apiGet(`/configs/${currentTerminalServerId}/output?offset=${currentTerminalOffset}`);

        // Update status badge
        const badge = document.getElementById('terminal-status');
        const text = document.getElementById('terminal-status-text');
        if (badge && text) {
            badge.className = 'terminal-status-badge ' + (data.running ? 'running' : 'stopped');
            text.textContent = data.running ? 'Running' : 'Stopped';
        }

        // Append lines
        if (data.lines && data.lines.length > 0) {
            const win = document.getElementById('terminal-window');
            if (win) {
                // Remove empty state if present
                const empty = win.querySelector('.terminal-empty');
                if (empty) empty.remove();

                const wasAtBottom = win.scrollHeight - win.scrollTop <= win.clientHeight + 20;

                data.lines.forEach(line => {
                    const div = document.createElement('div');
                    div.className = 'terminal-line';
                    div.textContent = line || ' '; // Keep empty lines tall
                    win.appendChild(div);
                });

                if (wasAtBottom) {
                    win.scrollTop = win.scrollHeight;
                }
            }
            currentTerminalOffset += data.lines.length;
        }

    } catch (e) {
        console.error('Terminal polling failed:', e);
    }
}

// ── Chat Page ──────────────────────────────────────────
let currentChatServerId = null;
let currentChatAgentId = null;

function renderChatPage() {
    const header = `
        <div class="chat-header">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--accent-primary)">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
            </svg>
            <h2 style="font-size: 1.1rem; margin-right: auto;">Chat</h2>
            <select class="chat-selector" id="chat-server-select">
                <option value="" disabled selected>Select a running server...</option>
                ${servers.filter(s => s.running).map(s => `<option value="${s.config.id}">${escapeHtml(s.config.name)}</option>`).join('')}
            </select>
            <select class="chat-selector" id="chat-agent-select" style="max-width: 200px;">
                <option value="">No agent (direct)</option>
                ${agents.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('')}
            </select>
            <button class="btn btn-ghost btn-sm" id="chat-clear-btn" disabled>Clear Chat</button>
        </div>`;

    if (servers.length === 0) {
        return `
            <div class="page-header">
                <div>
                    <h1>Chat</h1>
                    <p class="subtitle">Interact with your loaded llama.cpp models</p>
                </div>
            </div>
            <div class="empty-state">
                <div class="empty-state-icon">
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                    </svg>
                </div>
                <h3>No Configurations</h3>
                <p>Create and start a server configuration first to begin chatting.</p>
                <a href="#configs" class="btn btn-primary">Go to Configs</a>
            </div>`;
    }

    return `
        <div class="chat-container">
            ${header}
            <div class="chat-history" id="chat-history">
                <div class="terminal-empty">Select a running server to start chatting</div>
            </div>
            <div class="chat-input-area">
                <textarea class="chat-textarea" id="chat-input" placeholder="Type a message... (Shift+Enter for newline)" disabled></textarea>
                <button class="btn btn-primary chat-send-btn" id="chat-send-btn" disabled>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="22" y1="2" x2="11" y2="13"></line>
                        <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                    </svg>
                </button>
            </div>
        </div>`;
}

function bindChatEvents() {
    const select = document.getElementById('chat-server-select');
    const agentSelect = document.getElementById('chat-agent-select');
    const input = document.getElementById('chat-input');
    const sendBtn = document.getElementById('chat-send-btn');
    const clearBtn = document.getElementById('chat-clear-btn');

    if (!select) return;

    select.addEventListener('change', (e) => {
        currentChatServerId = e.target.value;
        const hasServer = !!currentChatServerId;
        input.disabled = !hasServer;
        sendBtn.disabled = !hasServer;
        clearBtn.disabled = !hasServer;

        const history = document.getElementById('chat-history');
        if (hasServer) {
            history.innerHTML = '<div class="terminal-empty">Start a conversation...</div>';
            input.focus();
        }
    });

    agentSelect?.addEventListener('change', (e) => {
        currentChatAgentId = e.target.value || null;
    });

    clearBtn?.addEventListener('click', async () => {
        if (!currentChatServerId) return;
        try {
            await apiPost(`/configs/${currentChatServerId}/chat/clear`);
            document.getElementById('chat-history').innerHTML = '<div class="terminal-empty">Chat cleared. Start a new conversation...</div>';
            showToast('Chat history cleared', 'info');
        } catch (e) {
            showToast('Failed to clear chat: ' + e.message, 'error');
        }
    });

    const sendMessage = async () => {
        if (!currentChatServerId || !input.value.trim()) return;

        const text = input.value.trim();
        input.value = '';
        input.style.height = '48px';

        const history = document.getElementById('chat-history');

        const empty = history.querySelector('.terminal-empty');
        if (empty) empty.remove();

        history.insertAdjacentHTML('beforeend', `
            <div class="chat-message user">
                <div class="chat-role">You</div>
                <div class="chat-bubble">${escapeHtml(text)}</div>
            </div>
        `);
        history.scrollTop = history.scrollHeight;

        const thinkingId = 'thinking-' + Date.now();
        history.insertAdjacentHTML('beforeend', `
            <div class="chat-thinking" id="${thinkingId}">
                <span>Assistant is typing</span>
                <div class="dot-flashing"></div>
            </div>
        `);
        history.scrollTop = history.scrollHeight;

        input.disabled = true;
        sendBtn.disabled = true;

        try {
            const data = await apiPost(`/configs/${currentChatServerId}/chat`, {
                message: text,
                temperature: 0.7,
                max_tokens: 2048,
                agent_id: currentChatAgentId,
            });

            document.getElementById(thinkingId)?.remove();

            history.insertAdjacentHTML('beforeend', `
                <div class="chat-message assistant">
                    <div class="chat-role">Assistant</div>
                    <div class="chat-bubble">${escapeHtml(data.message)}</div>
                </div>
            `);
        } catch (e) {
            document.getElementById(thinkingId)?.remove();
            showToast('Chat failed: ' + e.message, 'error');
        } finally {
            history.scrollTop = history.scrollHeight;
            input.disabled = false;
            sendBtn.disabled = false;
            input.focus();
        }
    };

    sendBtn?.addEventListener('click', sendMessage);

    input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    input?.addEventListener('input', function () {
        this.style.height = '48px';
        this.style.height = (this.scrollHeight) + 'px';
    });
}

// ── Modal ──────────────────────────────────────────────
function openModal(config = null) {
    const modal = document.getElementById('config-modal');
    const title = document.getElementById('modal-title');
    const form = document.getElementById('config-form');

    title.textContent = config ? 'Edit Configuration' : 'New Configuration';

    // Populate form
    document.getElementById('config-id').value = config?.id || '';
    document.getElementById('config-name').value = config?.name || '';
    document.getElementById('config-model-path').value = config?.model_path || '';
    document.getElementById('config-host').value = config?.host || '127.0.0.1';
    document.getElementById('config-port').value = config?.port || 8080;
    document.getElementById('config-gpu-layers').value = config?.n_gpu_layers ?? -1;
    document.getElementById('config-ctx-size').value = config?.ctx_size || 4096;
    document.getElementById('config-threads').value = config?.threads || 4;
    document.getElementById('config-parallel').value = config?.parallel || 1;
    document.getElementById('config-cont-batching').checked = config?.cont_batching ?? true;
    document.getElementById('config-extra-args').value = config?.extra_args || '';

    modal.classList.add('open');
}

function closeModal() {
    document.getElementById('config-modal').classList.remove('open');
}

// ── Modal Events ───────────────────────────────────────
document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-cancel').addEventListener('click', closeModal);
document.getElementById('config-modal').addEventListener('click', (e) => {
    if (e.target.id === 'config-modal') closeModal();
});

document.getElementById('config-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('config-id').value;
    const data = {
        name: document.getElementById('config-name').value,
        model_path: document.getElementById('config-model-path').value,
        host: document.getElementById('config-host').value,
        port: parseInt(document.getElementById('config-port').value),
        n_gpu_layers: parseInt(document.getElementById('config-gpu-layers').value),
        ctx_size: parseInt(document.getElementById('config-ctx-size').value),
        threads: parseInt(document.getElementById('config-threads').value),
        parallel: parseInt(document.getElementById('config-parallel').value),
        cont_batching: document.getElementById('config-cont-batching').checked,
        extra_args: document.getElementById('config-extra-args').value,
    };

    try {
        if (id) {
            await apiPut(`/configs/${id}`, data);
            showToast('Configuration updated', 'success');
        } else {
            await apiPost('/configs', data);
            showToast('Configuration created', 'success');
        }
        closeModal();
        render();
    } catch (e) {
        showToast('Failed to save: ' + e.message, 'error');
    }
});

// ── Agent Modal Events ─────────────────────────────────
document.getElementById('agent-modal-close').addEventListener('click', closeAgentModal);
document.getElementById('agent-modal-cancel').addEventListener('click', closeAgentModal);
document.getElementById('agent-modal').addEventListener('click', (e) => {
    if (e.target.id === 'agent-modal') closeAgentModal();
});

document.getElementById('agent-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('agent-id').value;
    const tools = [...document.querySelectorAll('#agent-form input[name="tool"]:checked')]
        .map(cb => cb.value);
    const soulPath = document.getElementById('agent-soul-path').value.trim() || null;
    const data = {
        name: document.getElementById('agent-name').value,
        tools,
        soul_md_path: soulPath,
    };

    try {
        if (id) {
            await apiPut(`/agents/${id}`, data);
            showToast('Agent updated', 'success');
        } else {
            await apiPost('/agents', data);
            showToast('Agent created', 'success');
        }
        closeAgentModal();
        render();
    } catch (e) {
        showToast('Failed to save agent: ' + e.message, 'error');
    }
});

// ── Confirm Dialog ─────────────────────────────────────
function showConfirm(title, message, onConfirm) {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
        <div class="confirm-dialog">
            <h3>${escapeHtml(title)}</h3>
            <p>${escapeHtml(message)}</p>
            <div class="confirm-actions">
                <button class="btn btn-ghost btn-sm confirm-cancel">Cancel</button>
                <button class="btn btn-danger btn-sm confirm-ok">Delete</button>
            </div>
        </div>`;

    document.body.appendChild(overlay);

    overlay.querySelector('.confirm-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('.confirm-ok').addEventListener('click', async () => {
        overlay.remove();
        await onConfirm();
    });
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });
}

// ── Toast Notifications ────────────────────────────────
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    requestAnimationFrame(() => {
        requestAnimationFrame(() => toast.classList.add('show'));
    });

    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 350);
    }, 3500);
}

// ── Utilities ──────────────────────────────────────────
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ── Init ───────────────────────────────────────────────
initRouter();
