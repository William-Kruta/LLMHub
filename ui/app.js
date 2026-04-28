const API_BASE = '/api';

let currentPage = 'hub';
let servers = [];
let gpus = [];
let ram = null;
let presets = [];
let settings = null;
let serverPoller = null;
let terminalPoller = null;
let currentTerminalServerId = null;
let currentTerminalOffset = 0;
let terminalPaused = false;
let terminalAutoScroll = true;
let terminalLines = [];
let hubFilter = '';
let hubStateFilter = 'all';
let modelPathOptions = [];
let modelPathOptionsDirectory = '';
let modelPathActiveIndex = -1;

function navigate(page) {
    currentPage = ['hub', 'configs', 'terminal', 'settings'].includes(page) ? page : 'hub';
    document.querySelectorAll('.nav-item').forEach(el => {
        el.classList.toggle('active', el.dataset.page === currentPage);
    });
    render();
}

function initRouter() {
    window.addEventListener('hashchange', () => navigate(location.hash.replace('#', '') || 'hub'));
    navigate(location.hash.replace('#', '') || 'hub');
}

async function apiGet(path) {
    const res = await fetch(`${API_BASE}${path}`);
    if (!res.ok) throw await apiError(res);
    return res.json();
}

async function apiPost(path, body = null) {
    const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${API_BASE}${path}`, opts);
    if (!res.ok) throw await apiError(res);
    return res.json();
}

async function apiPut(path, body) {
    const res = await fetch(`${API_BASE}${path}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw await apiError(res);
    return res.json();
}

async function apiDelete(path) {
    const res = await fetch(`${API_BASE}${path}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) throw await apiError(res);
}

async function apiError(res) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    return new Error(err.detail || 'Request failed');
}

async function fetchServers({ quiet = false } = {}) {
    try {
        servers = await apiGet('/configs');
    } catch (e) {
        servers = [];
        if (!quiet) showToast('Failed to fetch servers: ' + e.message, 'error');
    }
}

async function fetchGpus({ quiet = false } = {}) {
    try {
        gpus = await apiGet('/gpus');
    } catch (e) {
        gpus = [];
        if (!quiet) showToast('Failed to fetch GPU status: ' + e.message, 'error');
    }
}

async function fetchRam({ quiet = false } = {}) {
    try {
        ram = await apiGet('/ram');
    } catch (e) {
        ram = null;
        if (!quiet) showToast('Failed to fetch RAM status: ' + e.message, 'error');
    }
}

async function fetchPresets() {
    if (presets.length) return;
    try {
        presets = await apiGet('/presets');
    } catch {
        presets = [];
    }
}

async function fetchSettings() {
    try {
        settings = await apiGet('/settings');
    } catch {
        settings = {
            default_host: '127.0.0.1',
            default_base_port: 8080,
            default_threads: 4,
            default_ctx_size: 4096,
            default_n_gpu_layers: -1,
            default_parallel: 1,
            default_preset: 'custom',
            model_scan_directory: '',
            refresh_interval_ms: 3000,
            terminal_retention_lines: 2000,
        };
    }
}

async function render() {
    await Promise.all([fetchServers(), fetchGpus(), fetchRam(), fetchPresets(), fetchSettings()]);
    const main = document.getElementById('main-content');
    stopHubPoller();

    if (currentPage === 'configs') {
        stopTerminalPoller();
        main.innerHTML = renderConfigsPage();
        bindConfigEvents();
    } else if (currentPage === 'terminal') {
        main.innerHTML = renderTerminalPage();
        bindTerminalEvents();
    } else if (currentPage === 'settings') {
        stopTerminalPoller();
        main.innerHTML = renderSettingsPage();
        bindSettingsEvents();
    } else {
        stopTerminalPoller();
        main.innerHTML = renderHubPage();
        bindHubEvents();
        startHubPoller();
    }
}

function startHubPoller() {
    serverPoller = setInterval(async () => {
        if (currentPage !== 'hub') {
            stopHubPoller();
            return;
        }
        await Promise.all([fetchServers({ quiet: true }), fetchGpus({ quiet: true }), fetchRam({ quiet: true })]);
        const main = document.getElementById('main-content');
        if (main) {
            main.innerHTML = renderHubPage();
            bindHubEvents();
        }
    }, settings?.refresh_interval_ms || 3000);
}

function stopHubPoller() {
    if (serverPoller) {
        clearInterval(serverPoller);
        serverPoller = null;
    }
}

function filteredServers() {
    const q = hubFilter.trim().toLowerCase();
    return servers.filter(s => {
        const c = s.config;
        const text = `${c.name} ${c.model_path} ${c.host} ${c.port}`.toLowerCase();
        const matchesText = !q || text.includes(q);
        const matchesState = hubStateFilter === 'all'
            || (hubStateFilter === 'running' && s.running)
            || (hubStateFilter === 'stopped' && !s.running)
            || s.health === hubStateFilter;
        return matchesText && matchesState;
    });
}

function renderToolbar() {
    return `
        <div class="toolbar">
            <input class="toolbar-search" id="hub-filter" type="search" placeholder="Filter by name, model, host, or port" value="${escapeHtml(hubFilter)}">
            <select class="toolbar-select" id="hub-state-filter">
                ${option('all', 'All states', hubStateFilter)}
                ${option('running', 'Running', hubStateFilter)}
                ${option('stopped', 'Stopped', hubStateFilter)}
                ${option('healthy', 'Healthy', hubStateFilter)}
                ${option('loading', 'Loading', hubStateFilter)}
                ${option('unreachable', 'Unreachable', hubStateFilter)}
            </select>
        </div>`;
}

function renderHubPage() {
    const header = `
        <div class="page-header">
            <div>
                <h1>Server Hub</h1>
                <p class="subtitle">Monitor and control your llama.cpp servers</p>
            </div>
        </div>
        ${renderResourceSection()}`;

    if (servers.length === 0) {
        return header + `
            <div class="empty-state">
                <div class="empty-state-icon">${serverIcon(36)}</div>
                <h3>No Servers Configured</h3>
                <p>Create your first server configuration to start managing llama.cpp instances.</p>
                <a href="#configs" class="btn btn-primary">${plusIcon(16)} Create Configuration</a>
            </div>`;
    }

    const visible = filteredServers();
    const cards = visible.map(renderServerCard).join('');

    return `
        ${header}
        ${renderToolbar()}
        ${visible.length ? `<div class="server-grid">${cards}</div>` : '<div class="empty-state"><h3>No Matches</h3><p>Adjust the filter to show more servers.</p></div>'}`;
}

function renderResourceSection() {
    if (!gpus.length && !ram) return '';
    return `
        <div class="resource-grid" aria-label="System status">
            ${ram ? renderRamCard(ram) : ''}
            ${gpus.map(renderGpuCard).join('')}
        </div>`;
}

function renderRamCard(memory) {
    const used = numberOrNull(memory.used_mb);
    const total = numberOrNull(memory.total_mb);
    const available = numberOrNull(memory.available_mb);
    const percent = numberOrNull(memory.percent_used);
    const swapUsed = numberOrNull(memory.swap_used_mb);
    const swapTotal = numberOrNull(memory.swap_total_mb);
    return `
        <div class="resource-card ram-card">
            <div class="resource-card-header">
                <div>
                    <div class="resource-title">System RAM</div>
                    <div class="resource-subtitle">${available != null ? `${formatMb(available)} available` : 'Memory'}</div>
                </div>
                <div class="resource-load">${percent != null ? `${percent}%` : 'n/a'}</div>
            </div>
            <div class="resource-meter" title="RAM used">
                <span style="width: ${percent != null ? Math.max(0, Math.min(100, percent)) : 0}%"></span>
            </div>
            <div class="resource-details">
                <div>
                    <span class="label">RAM</span>
                    <span class="value">${formatVram(used, total)}</span>
                </div>
                <div>
                    <span class="label">Used</span>
                    <span class="value">${percent != null ? `${percent}%` : 'n/a'}</span>
                </div>
                <div>
                    <span class="label">Available</span>
                    <span class="value">${available != null ? formatMb(available) : 'n/a'}</span>
                </div>
                <div>
                    <span class="label">Swap</span>
                    <span class="value">${formatVram(swapUsed, swapTotal)}</span>
                </div>
            </div>
        </div>`;
}

function renderGpuCard(gpu) {
    const used = numberOrNull(gpu.vram_used_mb);
    const total = numberOrNull(gpu.vram_total_mb);
    const vramPercent = used != null && total ? Math.min(100, Math.round((used / total) * 100)) : null;
    const load = numberOrNull(gpu.gpu_util_percent);
    const temp = numberOrNull(gpu.temperature_c);
    const power = numberOrNull(gpu.power_draw_w);
    const powerLimit = numberOrNull(gpu.power_limit_w);
    return `
        <div class="resource-card gpu-card">
            <div class="resource-card-header">
                <div>
                    <div class="resource-title">${escapeHtml(gpu.name || `GPU ${gpu.index}`)}</div>
                    <div class="resource-subtitle">${escapeHtml(gpu.vendor || 'GPU')} ${gpu.index != null ? `#${gpu.index}` : ''}</div>
                </div>
                <div class="resource-load">${load != null ? `${load}%` : 'n/a'}</div>
            </div>
            <div class="resource-meter" title="GPU load">
                <span style="width: ${load != null ? Math.max(0, Math.min(100, load)) : 0}%"></span>
            </div>
            <div class="resource-details">
                <div>
                    <span class="label">VRAM</span>
                    <span class="value">${formatVram(used, total)}</span>
                </div>
                <div>
                    <span class="label">Memory</span>
                    <span class="value">${vramPercent != null ? `${vramPercent}%` : 'n/a'}</span>
                </div>
                <div>
                    <span class="label">Temp</span>
                    <span class="value">${temp != null ? `${temp} C` : 'n/a'}</span>
                </div>
                <div>
                    <span class="label">Power</span>
                    <span class="value">${formatPower(power, powerLimit)}</span>
                </div>
            </div>
        </div>`;
}

function renderServerCard(s) {
    const c = s.config;
    const modelName = c.model_path.split('/').pop();
    const health = s.health || (s.running ? 'running' : 'stopped');
    const recent = (s.recent_output || []).slice(-4);
    const showRecent = s.running && recent.length > 0 && health !== 'healthy';
    const warnings = s.validation_warnings || [];
    const startup = s.startup_elapsed_seconds != null ? `${s.startup_elapsed_seconds}s` : 'n/a';

    return `
        <div class="server-card ${health}" data-id="${c.id}">
            <div class="card-header">
                <div>
                    <div class="card-title">${escapeHtml(c.name)}</div>
                    <div class="card-subtitle">${escapeHtml(modelName)}</div>
                </div>
                <div class="card-status ${health}" title="${escapeHtml(s.status_detail || health)}">
                    <span class="status-dot"></span>
                    ${labelForHealth(health)}
                </div>
            </div>
            <div class="card-details">
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
                <div class="card-detail">
                    <span class="label">Last Started</span>
                    <span class="value">${relativeTime(c.last_started_at)}</span>
                </div>
                <div class="card-detail">
                    <span class="label">Startup</span>
                    <span class="value">${startup}</span>
                </div>
            </div>
            ${warnings.length ? `<div class="card-warning">${escapeHtml(warnings[0])}</div>` : ''}
            ${s.failure_summary ? `<div class="card-warning">${escapeHtml(s.failure_summary)}</div>` : ''}
            ${showRecent ? `<div class="card-output">${recent.map(line => `<div>${escapeHtml(line || ' ')}</div>`).join('')}</div>` : ''}
            <div class="card-actions">
                ${s.running
                    ? `<button class="btn btn-danger btn-sm stop-btn" data-id="${c.id}">${stopIcon(14)} Stop</button>
                       <button class="btn btn-ghost btn-sm restart-btn" data-id="${c.id}">${restartIcon(14)} Restart</button>`
                    : `<button class="btn btn-primary btn-sm start-btn" data-id="${c.id}">${playIcon(14)} Start</button>`}
                <button class="btn btn-ghost btn-sm copy-url-btn" data-url="${serverUrl(c)}">${copyIcon(14)} URL</button>
                <button class="btn btn-ghost btn-sm details-btn" data-id="${c.id}">Details</button>
                <button class="btn btn-ghost btn-sm test-endpoint-btn" data-id="${c.id}">Test</button>
                <button class="btn btn-ghost btn-sm benchmark-btn" data-id="${c.id}">Benchmark</button>
            </div>
        </div>`;
}

function bindHubEvents() {
    bindToolbar();
    bindServerAction('.start-btn', 'Starting...', id => apiPost(`/configs/${id}/start`), 'Server started successfully');
    bindServerAction('.stop-btn', 'Stopping...', id => apiPost(`/configs/${id}/stop`), 'Server stopped');
    bindServerAction('.restart-btn', 'Restarting...', id => apiPost(`/configs/${id}/restart`), 'Server restarted');
    document.querySelectorAll('.copy-url-btn').forEach(btn => {
        btn.addEventListener('click', () => copyText(btn.dataset.url, 'Server URL copied'));
    });
    document.querySelectorAll('.details-btn').forEach(btn => {
        btn.addEventListener('click', () => showDetails(btn.dataset.id));
    });
    document.querySelectorAll('.test-endpoint-btn').forEach(btn => {
        btn.addEventListener('click', () => testEndpoint(btn.dataset.id));
    });
    document.querySelectorAll('.benchmark-btn').forEach(btn => {
        btn.addEventListener('click', () => benchmarkEndpoint(btn.dataset.id));
    });
}

function bindToolbar() {
    document.getElementById('hub-filter')?.addEventListener('input', e => {
        hubFilter = e.target.value;
        document.getElementById('main-content').innerHTML = renderHubPage();
        bindHubEvents();
    });
    document.getElementById('hub-state-filter')?.addEventListener('change', e => {
        hubStateFilter = e.target.value;
        document.getElementById('main-content').innerHTML = renderHubPage();
        bindHubEvents();
    });
}

function bindServerAction(selector, progressText, action, successText) {
    document.querySelectorAll(selector).forEach(btn => {
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            btn.textContent = progressText;
            try {
                await action(btn.dataset.id);
                showToast(successText, 'success');
            } catch (e) {
                showToast(e.message, 'error');
            }
            render();
        });
    });
}

function renderConfigsPage() {
    const header = `
        <div class="page-header">
            <div>
                <h1>Configurations</h1>
                <p class="subtitle">Create, duplicate, import, and export server configurations</p>
            </div>
            <div class="header-actions">
                <button class="btn btn-ghost" id="scan-models-btn">Scan Models</button>
                <button class="btn btn-ghost" id="import-configs-btn">${uploadIcon(16)} Import</button>
                <button class="btn btn-ghost" id="export-configs-btn">${downloadIcon(16)} Export</button>
                <button class="btn btn-primary" id="new-config-btn">${plusIcon(16)} New Config</button>
                <input id="import-configs-input" type="file" accept="application/json,.json" hidden>
            </div>
        </div>`;

    if (servers.length === 0) {
        return header + `
            <div class="empty-state">
                <div class="empty-state-icon">${gearIcon(36)}</div>
                <h3>No Configurations Yet</h3>
                <p>Create a server configuration for your llama.cpp model.</p>
            </div>`;
    }

    const items = servers.map(s => {
        const c = s.config;
        const modelName = c.model_path.split('/').pop();
        const locked = s.running ? 'disabled title="Stop server first"' : '';

        return `
            <div class="config-item" data-id="${c.id}">
                <div class="config-item-info">
                    <div class="config-item-name">
                        ${escapeHtml(c.name)}
                        <span class="inline-status ${s.health}">${labelForHealth(s.health)}</span>
                    </div>
                    <div class="config-item-meta">
                        <span title="${escapeHtml(c.model_path)}">${escapeHtml(modelName)}</span>
                        <span>${escapeHtml(c.host)}:${c.port}</span>
                        <span>GPU: ${c.n_gpu_layers === -1 ? 'All' : c.n_gpu_layers}</span>
                        <span>Ctx: ${c.ctx_size.toLocaleString()}</span>
                        <span>Updated: ${relativeTime(c.updated_at)}</span>
                    </div>
                </div>
                <div class="config-item-actions">
                    <button class="btn btn-ghost btn-sm copy-command-btn" data-id="${c.id}">${copyIcon(14)} Command</button>
                    <button class="btn btn-ghost btn-sm export-one-btn" data-id="${c.id}">${downloadIcon(14)} Export</button>
                    <button class="btn btn-ghost btn-sm duplicate-btn" data-id="${c.id}">${copyIcon(14)} Duplicate</button>
                    <button class="btn btn-ghost btn-sm edit-btn" data-id="${c.id}" ${locked}>${editIcon(14)} Edit</button>
                    <button class="btn btn-danger btn-sm delete-btn" data-id="${c.id}" data-name="${escapeHtml(c.name)}" ${locked}>${trashIcon(14)} Delete</button>
                </div>
            </div>`;
    }).join('');

    return header + `<div class="config-list">${items}</div>`;
}

function bindConfigEvents() {
    document.getElementById('new-config-btn')?.addEventListener('click', () => openModal());
    document.getElementById('scan-models-btn')?.addEventListener('click', scanModels);
    document.getElementById('export-configs-btn')?.addEventListener('click', exportConfigs);
    document.getElementById('import-configs-btn')?.addEventListener('click', () => document.getElementById('import-configs-input').click());
    document.getElementById('import-configs-input')?.addEventListener('change', importConfigs);

    document.querySelectorAll('.edit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const server = servers.find(s => s.config.id === btn.dataset.id);
            if (server) openModal(server.config);
        });
    });

    document.querySelectorAll('.duplicate-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            try {
                await apiPost(`/configs/${btn.dataset.id}/duplicate`);
                showToast('Configuration duplicated', 'success');
                render();
            } catch (e) {
                showToast('Failed to duplicate: ' + e.message, 'error');
            }
        });
    });

    document.querySelectorAll('.copy-command-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            try {
                const data = await apiGet(`/configs/${btn.dataset.id}/command`);
                copyText(data.command_text, 'Command copied');
            } catch (e) {
                showToast('Failed to copy command: ' + e.message, 'error');
            }
        });
    });

    document.querySelectorAll('.export-one-btn').forEach(btn => {
        btn.addEventListener('click', () => exportOneConfig(btn.dataset.id));
    });

    document.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            showConfirm(`Delete "${btn.dataset.name}"?`, 'This action cannot be undone.', async () => {
                try {
                    await apiDelete(`/configs/${btn.dataset.id}`);
                    showToast('Configuration deleted', 'info');
                    render();
                } catch (e) {
                    showToast('Failed to delete: ' + e.message, 'error');
                }
            });
        });
    });
}

async function scanModels() {
    const directory = prompt('Directory to scan for .gguf and .mmproj files', settings?.model_scan_directory || '');
    if (!directory) return;
    try {
        const results = await apiGet(`/models/scan?directory=${encodeURIComponent(directory)}`);
        const models = results.filter(item => item.kind === 'model');
        const mmprojs = results.filter(item => item.kind === 'mmproj');
        if (!models.length) {
            showToast('No models found', 'info');
            return;
        }
        showScannerPreview(models, mmprojs);
    } catch (e) {
        showToast('Scan failed: ' + e.message, 'error');
    }
}

function showScannerPreview(models, mmprojs) {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    const maxPort = Math.max((settings?.default_base_port || 8080) - 1, ...servers.map(s => s.config.port || 8079));
    const rows = models.map((model, index) => {
        const stem = model.name.replace(/\.gguf$/i, '');
        const pairedMmproj = mmprojs.find(item => item.name.replace(/\.mmproj$/i, '') === stem);
        return { model, stem, pairedMmproj, port: maxPort + index + 1 };
    });
    overlay.innerHTML = `
        <div class="confirm-dialog scanner-dialog">
            <h3>Import Scanned Models</h3>
            <p>${models.length} model${models.length === 1 ? '' : 's'} found. Review names, ports, and mmproj matches before creating configs.</p>
            <div class="scanner-table">
                <div class="scanner-row scanner-head">
                    <span></span>
                    <span>Model</span>
                    <span>Size</span>
                    <span>Projector</span>
                    <span>Name</span>
                    <span>Port</span>
                </div>
                ${rows.map((row, index) => `
                    <label class="scanner-row">
                        <input type="checkbox" class="scan-check" data-index="${index}" checked>
                        <span>${escapeHtml(row.stem)}</span>
                        <span>${escapeHtml(row.model.size_label)}</span>
                        <span>${row.pairedMmproj ? 'mmproj paired' : 'model only'}</span>
                        <input class="scan-name" data-index="${index}" value="${escapeHtml(autoName(row.stem))}">
                        <input class="scan-port" data-index="${index}" type="number" value="${row.port}">
                    </label>
                `).join('')}
            </div>
            <div class="confirm-actions">
                <button class="btn btn-ghost btn-sm confirm-cancel">Cancel</button>
                <button class="btn btn-primary btn-sm scanner-create">Create Selected</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.confirm-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('.scanner-create').addEventListener('click', async () => {
        const configs = rows.flatMap((row, index) => {
            const checked = overlay.querySelector(`.scan-check[data-index="${index}"]`).checked;
            if (!checked) return [];
            const port = parseInt(overlay.querySelector(`.scan-port[data-index="${index}"]`).value, 10);
            return [{
                name: overlay.querySelector(`.scan-name[data-index="${index}"]`).value || row.stem,
                model_path: row.model.path,
                mmproj_path: row.pairedMmproj?.path || '',
                host: settings?.default_host || '127.0.0.1',
                port: Number.isFinite(port) ? port : row.port,
                n_gpu_layers: settings?.default_n_gpu_layers ?? -1,
                ctx_size: settings?.default_ctx_size || 4096,
                threads: settings?.default_threads || 4,
                parallel: settings?.default_parallel || 1,
                cont_batching: true,
                preset: settings?.default_preset || 'custom',
            }];
        });
        if (!configs.length) return;
        await apiPost('/configs/import', configs);
        overlay.remove();
        showToast(`Created ${configs.length} configs`, 'success');
        render();
    });
}

function autoName(name) {
    return name
        .replace(/[-_.](Q[0-9_KM]+|IQ[0-9A-Z_]+|f16|bf16)$/i, '')
        .replace(/[-_.]+/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase())
        .trim();
}

async function exportConfigs() {
    try {
        const data = await apiGet('/configs/export');
        downloadJson(data, `llmhub-configs-${new Date().toISOString().slice(0, 10)}.json`);
    } catch (e) {
        showToast('Export failed: ' + e.message, 'error');
    }
}

async function exportOneConfig(configId) {
    try {
        const data = await apiGet(`/configs/${configId}/export`);
        const safeName = (data.name || 'server').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
        downloadJson(data, `llmhub-${safeName || 'server'}-${configId}.json`);
    } catch (e) {
        showToast('Export failed: ' + e.message, 'error');
    }
}

function showDetails(configId) {
    const server = servers.find(s => s.config.id === configId);
    if (!server) return;
    const c = server.config;
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
        <div class="confirm-dialog" style="max-width: 720px;">
            <h3>${escapeHtml(c.name)}</h3>
            <dl class="details-list">
                <dt>Model</dt><dd>${escapeHtml(c.model_path)}</dd>
                <dt>Size</dt><dd>${escapeHtml(server.model_size_label || 'Unknown')}</dd>
                <dt>Address</dt><dd>${escapeHtml(serverUrl(c))}</dd>
                <dt>Preset</dt><dd>${escapeHtml(c.preset || 'custom')}</dd>
                <dt>Health</dt><dd>${escapeHtml(labelForHealth(server.health))}${server.status_detail ? ` - ${escapeHtml(server.status_detail)}` : ''}</dd>
                <dt>Startup</dt><dd>${server.startup_elapsed_seconds ?? 'n/a'} seconds</dd>
                <dt>Last exit</dt><dd>${server.last_exit_code ?? 'n/a'} ${server.failure_summary ? `- ${escapeHtml(server.failure_summary)}` : ''}</dd>
                <dt>Warnings</dt><dd>${escapeHtml((server.validation_warnings || []).join('; ') || 'None')}</dd>
                <dt>Resource hints</dt><dd>${escapeHtml((server.resource_hints || []).join('; ') || 'None')}</dd>
                <dt>Command</dt><dd>${escapeHtml(server.command_text)}</dd>
            </dl>
            <div class="confirm-actions">
                <button class="btn btn-ghost btn-sm confirm-cancel">Close</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.confirm-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => {
        if (e.target === overlay) overlay.remove();
    });
}

async function testEndpoint(configId) {
    try {
        const result = await apiPost(`/configs/${configId}/test`);
        if (result.ok) {
            showToast(`Endpoint OK${result.models?.length ? ': ' + result.models.join(', ') : ''}`, 'success');
        } else {
            showToast('Endpoint test failed: ' + result.detail, 'error');
        }
    } catch (e) {
        showToast('Endpoint test failed: ' + e.message, 'error');
    }
}

async function benchmarkEndpoint(configId) {
    try {
        const result = await apiPost(`/configs/${configId}/benchmark`);
        if (result.ok) {
            showToast(`Benchmark: ${result.latency_ms}ms${result.tokens_per_second ? `, ${result.tokens_per_second} tok/s` : ''}`, 'success');
        } else {
            showToast('Benchmark failed: ' + result.detail, 'error');
        }
    } catch (e) {
        showToast('Benchmark failed: ' + e.message, 'error');
    }
}

async function importConfigs(event) {
    const file = event.target.files[0];
    if (!file) return;
    try {
        const parsed = JSON.parse(await file.text());
        await apiPost('/configs/import', parsed);
        showToast('Configurations imported', 'success');
        render();
    } catch (e) {
        showToast('Import failed: ' + e.message, 'error');
    } finally {
        event.target.value = '';
    }
}

function downloadJson(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
}

function renderTerminalPage() {
    stopTerminalPoller();

    const header = `
        <div class="page-header">
            <div>
                <h1>Server Terminal</h1>
                <p class="subtitle">View, filter, copy, and download retained server output</p>
            </div>
        </div>`;

    if (servers.length === 0) {
        return header + `
            <div class="empty-state">
                <div class="empty-state-icon">${terminalIcon(36)}</div>
                <h3>No Configurations</h3>
                <p>Create a server configuration first to view terminal output.</p>
                <a href="#configs" class="btn btn-primary">Go to Configs</a>
            </div>`;
    }

    const options = servers.map(s => `<option value="${s.config.id}">${escapeHtml(s.config.name)}</option>`).join('');
    return header + `
        <div class="terminal-container">
            <div class="terminal-header terminal-header-wrap">
                <select class="terminal-selector" id="terminal-server-select">${options}</select>
                <div class="terminal-status-badge stopped" id="terminal-status">
                    <span class="status-dot"></span> <span id="terminal-status-text">Stopped</span>
                </div>
                <input class="terminal-filter" id="terminal-filter" type="search" placeholder="Filter output">
                <button class="btn btn-ghost btn-sm" id="terminal-pause-btn">Pause</button>
                <button class="btn btn-ghost btn-sm" id="terminal-autoscroll-btn">Auto-scroll On</button>
                <button class="btn btn-ghost btn-sm" id="terminal-copy-btn">${copyIcon(14)} Copy</button>
                <button class="btn btn-ghost btn-sm" id="terminal-download-btn">${downloadIcon(14)} Logs</button>
                <button class="btn btn-ghost btn-sm" id="terminal-clear-btn">Clear</button>
            </div>
            <div id="terminal-annotations" class="terminal-annotations"></div>
            <div class="terminal-window" id="terminal-window">
                <div class="terminal-empty">Select a server to view output</div>
            </div>
        </div>`;
}

function bindTerminalEvents() {
    const select = document.getElementById('terminal-server-select');
    if (!select) return;

    select.addEventListener('change', e => switchTerminalServer(e.target.value));
    document.getElementById('terminal-filter')?.addEventListener('input', renderTerminalLines);
    document.getElementById('terminal-pause-btn')?.addEventListener('click', toggleTerminalPause);
    document.getElementById('terminal-autoscroll-btn')?.addEventListener('click', toggleTerminalAutoscroll);
    document.getElementById('terminal-copy-btn')?.addEventListener('click', copyTerminalOutput);
    document.getElementById('terminal-download-btn')?.addEventListener('click', downloadTerminalLogs);
    document.getElementById('terminal-clear-btn')?.addEventListener('click', clearTerminalOutput);

    select.value = currentTerminalServerId || servers[0].config.id;
    switchTerminalServer(select.value);
}

function renderSettingsPage() {
    const s = settings || {};
    return `
        <div class="page-header">
            <div>
                <h1>Settings</h1>
                <p class="subtitle">Defaults for config creation, scanning, refresh, and terminal retention</p>
            </div>
        </div>
        <form class="settings-panel" id="settings-form">
            <div class="form-grid">
                <div class="form-group">
                    <label for="settings-host">Default Host</label>
                    <input type="text" id="settings-host" value="${escapeHtml(s.default_host || '127.0.0.1')}">
                </div>
                <div class="form-group">
                    <label for="settings-port">Base Port</label>
                    <input type="number" id="settings-port" value="${s.default_base_port || 8080}">
                </div>
                <div class="form-group">
                    <label for="settings-gpu">GPU Layers</label>
                    <input type="number" id="settings-gpu" value="${s.default_n_gpu_layers ?? -1}">
                </div>
                <div class="form-group">
                    <label for="settings-ctx">Context Size</label>
                    <input type="number" id="settings-ctx" value="${s.default_ctx_size || 4096}">
                </div>
                <div class="form-group">
                    <label for="settings-threads">Threads</label>
                    <input type="number" id="settings-threads" value="${s.default_threads || 4}">
                </div>
                <div class="form-group">
                    <label for="settings-parallel">Parallel Slots</label>
                    <input type="number" id="settings-parallel" value="${s.default_parallel || 1}">
                </div>
                <div class="form-group full-width">
                    <label for="settings-preset">Default Preset</label>
                    <select id="settings-preset">
                        <option value="custom">Custom</option>
                        ${presets.map(p => `<option value="${p.id}" ${p.id === s.default_preset ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
                    </select>
                </div>
                <div class="form-group full-width">
                    <label for="settings-scan-dir">Model Scan Directory</label>
                    <input type="text" id="settings-scan-dir" value="${escapeHtml(s.model_scan_directory || '')}">
                </div>
                <div class="form-group">
                    <label for="settings-refresh">Refresh Interval MS</label>
                    <input type="number" id="settings-refresh" value="${s.refresh_interval_ms || 3000}">
                </div>
                <div class="form-group">
                    <label for="settings-retention">Terminal Retention Lines</label>
                    <input type="number" id="settings-retention" value="${s.terminal_retention_lines || 2000}">
                </div>
            </div>
            <div class="modal-actions">
                <button type="submit" class="btn btn-primary">Save Settings</button>
            </div>
        </form>`;
}

function bindSettingsEvents() {
    document.getElementById('settings-form')?.addEventListener('submit', async e => {
        e.preventDefault();
        const payload = {
            default_host: document.getElementById('settings-host').value || '127.0.0.1',
            default_base_port: parseInt(document.getElementById('settings-port').value, 10),
            default_n_gpu_layers: parseInt(document.getElementById('settings-gpu').value, 10),
            default_ctx_size: parseInt(document.getElementById('settings-ctx').value, 10),
            default_threads: parseInt(document.getElementById('settings-threads').value, 10),
            default_parallel: parseInt(document.getElementById('settings-parallel').value, 10),
            default_preset: document.getElementById('settings-preset').value || 'custom',
            model_scan_directory: document.getElementById('settings-scan-dir').value,
            refresh_interval_ms: parseInt(document.getElementById('settings-refresh').value, 10),
            terminal_retention_lines: parseInt(document.getElementById('settings-retention').value, 10),
        };
        try {
            settings = await apiPut('/settings', payload);
            showToast('Settings saved', 'success');
        } catch (err) {
            showToast('Failed to save settings: ' + err.message, 'error');
        }
    });
}

function switchTerminalServer(serverId) {
    currentTerminalServerId = serverId;
    currentTerminalOffset = 0;
    terminalLines = [];
    renderTerminalLines();
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
    if (currentPage !== 'terminal' || !currentTerminalServerId || terminalPaused) return;

    try {
        const data = await apiGet(`/configs/${currentTerminalServerId}/output?offset=${currentTerminalOffset}`);
        const server = servers.find(s => s.config.id === currentTerminalServerId);
        updateTerminalStatus(data.running, server?.health);

        if (data.lines && data.lines.length > 0) {
            terminalLines.push(...data.lines);
            currentTerminalOffset += data.lines.length;
            renderTerminalLines();
        }
        renderLogAnnotations(data.annotations || []);
    } catch (e) {
        console.error('Terminal polling failed:', e);
    }
}

function renderLogAnnotations(annotations) {
    const panel = document.getElementById('terminal-annotations');
    if (!panel) return;
    if (!annotations.length) {
        panel.innerHTML = '';
        return;
    }
    panel.innerHTML = annotations.map(item => `
        <div class="log-annotation ${item.severity}">
            <strong>${escapeHtml(item.title)}</strong>
            <span>${escapeHtml(item.detail)}</span>
        </div>
    `).join('');
}

function renderTerminalLines() {
    const win = document.getElementById('terminal-window');
    if (!win) return;

    const filter = document.getElementById('terminal-filter')?.value.trim().toLowerCase() || '';
    const visible = filter ? terminalLines.filter(line => line.toLowerCase().includes(filter)) : terminalLines;

    if (!visible.length) {
        win.innerHTML = `<div class="terminal-empty">${escapeHtml(terminalEmptyMessage())}</div>`;
        return;
    }

    const wasAtBottom = win.scrollHeight - win.scrollTop <= win.clientHeight + 20;
    win.innerHTML = visible.map(line => `<div class="terminal-line">${escapeHtml(line || ' ')}</div>`).join('');
    if (terminalAutoScroll && wasAtBottom) win.scrollTop = win.scrollHeight;
}

function terminalEmptyMessage() {
    const server = servers.find(s => s.config.id === currentTerminalServerId);
    if (!server) return 'No output to show';
    if (server.running && server.pid == null) return 'No captured output for externally started server';
    if (server.running) return 'Waiting for server output';
    return 'No output to show';
}

function updateTerminalStatus(running, health) {
    const badge = document.getElementById('terminal-status');
    const text = document.getElementById('terminal-status-text');
    const label = health || (running ? 'running' : 'stopped');
    if (badge && text) {
        badge.className = 'terminal-status-badge ' + label;
        text.textContent = labelForHealth(label);
    }
}

function toggleTerminalPause() {
    terminalPaused = !terminalPaused;
    document.getElementById('terminal-pause-btn').textContent = terminalPaused ? 'Resume' : 'Pause';
}

function toggleTerminalAutoscroll() {
    terminalAutoScroll = !terminalAutoScroll;
    document.getElementById('terminal-autoscroll-btn').textContent = terminalAutoScroll ? 'Auto-scroll On' : 'Auto-scroll Off';
}

function copyTerminalOutput() {
    const filter = document.getElementById('terminal-filter')?.value.trim().toLowerCase() || '';
    const visible = filter ? terminalLines.filter(line => line.toLowerCase().includes(filter)) : terminalLines;
    copyText(visible.join('\n'), 'Terminal output copied');
}

function downloadTerminalLogs() {
    if (!currentTerminalServerId) return;
    window.location.href = `${API_BASE}/configs/${currentTerminalServerId}/logs`;
}

async function clearTerminalOutput() {
    if (!currentTerminalServerId) return;
    try {
        await apiPost(`/configs/${currentTerminalServerId}/output/clear`);
        terminalLines = [];
        currentTerminalOffset = 0;
        renderTerminalLines();
        showToast('Terminal output cleared', 'info');
    } catch (e) {
        showToast('Failed to clear output: ' + e.message, 'error');
    }
}

function openModal(config = null) {
    populatePresetSelect();
    const defaults = settings || {};
    document.getElementById('modal-title').textContent = config ? 'Edit Configuration' : 'New Configuration';
    document.getElementById('config-id').value = config?.id || '';
    document.getElementById('config-name').value = config?.name || '';
    document.getElementById('config-model-path').value = config?.model_path || '';
    document.getElementById('config-preset').value = config?.preset || defaults.default_preset || 'custom';
    document.getElementById('config-host').value = config?.host || defaults.default_host || '127.0.0.1';
    document.getElementById('config-port').value = config?.port || defaults.default_base_port || 8080;
    document.getElementById('config-gpu-layers').value = config?.n_gpu_layers ?? defaults.default_n_gpu_layers ?? -1;
    document.getElementById('config-ctx-size').value = config?.ctx_size || defaults.default_ctx_size || 4096;
    document.getElementById('config-threads').value = config?.threads || defaults.default_threads || 4;
    document.getElementById('config-parallel').value = config?.parallel || defaults.default_parallel || 1;
    document.getElementById('config-cont-batching').checked = config?.cont_batching ?? true;
    document.getElementById('config-mmproj-path').value = config?.mmproj_path || '';
    document.getElementById('config-extra-args').value = config?.extra_args || '';
    document.getElementById('config-advanced-args').value = (config?.advanced_args || []).join('\n');
    document.getElementById('config-env-vars').value = Object.entries(config?.env_vars || {}).map(([key, value]) => `${key}=${value}`).join('\n');
    setupModelPathPicker();
    updateCommandPreview();
    document.getElementById('config-modal').classList.add('open');
}

function populatePresetSelect() {
    const select = document.getElementById('config-preset');
    if (!select) return;
    select.innerHTML = `<option value="custom">Custom</option>${presets.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}`;
}

function closeModal() {
    document.getElementById('config-modal').classList.remove('open');
    hideModelPathMenu();
}

async function setupModelPathPicker() {
    const input = document.getElementById('config-model-path');
    const hint = document.getElementById('model-path-hint');
    const directory = (settings?.model_scan_directory || '').trim();

    hideModelPathMenu();
    modelPathActiveIndex = -1;
    if (!input || !hint) return;

    if (!directory) {
        modelPathOptions = [];
        modelPathOptionsDirectory = '';
        hint.textContent = '';
        input.placeholder = '/path/to/model.gguf';
        return;
    }

    input.placeholder = 'Type or select a GGUF model';
    hint.textContent = `Loading GGUF models from ${directory}...`;

    if (modelPathOptionsDirectory !== directory) {
        try {
            const results = await apiGet(`/models/scan?directory=${encodeURIComponent(directory)}&limit=1000`);
            modelPathOptions = results
                .filter(item => item.kind === 'model')
                .sort((a, b) => a.name.localeCompare(b.name));
            modelPathOptionsDirectory = directory;
        } catch (e) {
            modelPathOptions = [];
            modelPathOptionsDirectory = '';
            hint.textContent = `Could not scan model directory: ${e.message}`;
            return;
        }
    }

    hint.textContent = modelPathOptions.length
        ? `${modelPathOptions.length} GGUF model${modelPathOptions.length === 1 ? '' : 's'} available from settings.`
        : `No GGUF models found in ${directory}.`;

    if (document.activeElement === input) renderModelPathOptions();
}

function renderModelPathOptions() {
    const input = document.getElementById('config-model-path');
    const menu = document.getElementById('model-path-menu');
    if (!input || !menu || !modelPathOptions.length || !modelPathOptionsDirectory) {
        hideModelPathMenu();
        return;
    }

    const query = input.value.trim().toLowerCase();
    const matches = modelPathOptions
        .filter(item => {
            if (!query) return true;
            return item.name.toLowerCase().includes(query) || item.path.toLowerCase().includes(query);
        })
        .slice(0, 50);

    modelPathActiveIndex = matches.length ? Math.min(Math.max(modelPathActiveIndex, 0), matches.length - 1) : -1;

    if (!matches.length) {
        menu.innerHTML = '<div class="model-path-option"><div class="model-path-option-name">No matching GGUF models</div></div>';
        menu.classList.add('open');
        return;
    }

    menu.innerHTML = matches.map((item, index) => `
        <div class="model-path-option ${index === modelPathActiveIndex ? 'active' : ''}" role="option" data-path="${escapeHtml(item.path)}">
            <div class="model-path-option-name">${escapeHtml(item.name)}</div>
            <div class="model-path-option-meta">${escapeHtml(item.size_label ? `${item.size_label} - ${item.path}` : item.path)}</div>
        </div>
    `).join('');
    menu.classList.add('open');

    menu.querySelectorAll('.model-path-option[data-path]').forEach((optionEl, index) => {
        optionEl.addEventListener('mouseenter', () => setModelPathActive(index));
        optionEl.addEventListener('mousedown', e => {
            e.preventDefault();
            selectModelPath(optionEl.dataset.path);
        });
    });
}

function handleModelPathKeydown(e) {
    const menu = document.getElementById('model-path-menu');
    const options = [...(menu?.querySelectorAll('.model-path-option[data-path]') || [])];
    if (e.key === 'Escape') {
        hideModelPathMenu();
        return;
    }
    if (!modelPathOptions.length || !modelPathOptionsDirectory) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!menu.classList.contains('open')) renderModelPathOptions();
        const visibleOptions = [...menu.querySelectorAll('.model-path-option[data-path]')];
        if (!visibleOptions.length) return;
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        modelPathActiveIndex = (modelPathActiveIndex + delta + visibleOptions.length) % visibleOptions.length;
        setModelPathActive(modelPathActiveIndex);
    }
    if (e.key === 'Enter' && menu?.classList.contains('open') && options[modelPathActiveIndex]) {
        e.preventDefault();
        selectModelPath(options[modelPathActiveIndex].dataset.path);
    }
}

function setModelPathActive(index) {
    modelPathActiveIndex = index;
    document.querySelectorAll('#model-path-menu .model-path-option').forEach((el, optionIndex) => {
        el.classList.toggle('active', optionIndex === index);
    });
}

function selectModelPath(path) {
    const input = document.getElementById('config-model-path');
    if (!input || !path) return;
    input.value = path;
    hideModelPathMenu();
    updateCommandPreview();
}

function hideModelPathMenu() {
    const menu = document.getElementById('model-path-menu');
    if (!menu) return;
    menu.classList.remove('open');
    menu.innerHTML = '';
    modelPathActiveIndex = -1;
}

document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-cancel').addEventListener('click', closeModal);
document.getElementById('config-modal').addEventListener('click', e => {
    if (e.target.id === 'config-modal') closeModal();
});

document.querySelectorAll('#config-form input, #config-form textarea, #config-form select').forEach(input => {
    input.addEventListener('input', updateCommandPreview);
    input.addEventListener('change', updateCommandPreview);
});

document.getElementById('config-model-path').addEventListener('focus', renderModelPathOptions);
document.getElementById('config-model-path').addEventListener('input', renderModelPathOptions);
document.getElementById('config-model-path').addEventListener('keydown', handleModelPathKeydown);
document.addEventListener('click', e => {
    const picker = document.querySelector('.model-path-combobox');
    if (picker && !picker.contains(e.target)) hideModelPathMenu();
});

document.getElementById('config-preset').addEventListener('change', e => {
    const preset = presets.find(p => p.id === e.target.value);
    if (!preset) return;
    Object.entries(preset.values || {}).forEach(([key, value]) => {
        const field = {
            n_gpu_layers: 'config-gpu-layers',
            ctx_size: 'config-ctx-size',
            threads: 'config-threads',
            parallel: 'config-parallel',
            extra_args: 'config-extra-args',
        }[key];
        if (field) document.getElementById(field).value = value;
    });
    updateCommandPreview();
});

document.getElementById('find-port-btn').addEventListener('click', async () => {
    try {
        const host = document.getElementById('config-host').value || '127.0.0.1';
        const start = document.getElementById('config-port').value || 8080;
        const data = await apiGet(`/ports/free?host=${encodeURIComponent(host)}&start=${encodeURIComponent(start)}`);
        document.getElementById('config-port').value = data.port;
        updateCommandPreview();
        showToast(`Free port found: ${data.port}`, 'success');
    } catch (e) {
        showToast('Could not find free port: ' + e.message, 'error');
    }
});

document.getElementById('config-form').addEventListener('submit', async e => {
    e.preventDefault();
    const id = document.getElementById('config-id').value;
    const data = formConfigData();

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
    } catch (err) {
        showToast('Failed to save: ' + err.message, 'error');
    }
});

function formConfigData() {
    return {
        name: document.getElementById('config-name').value,
        model_path: document.getElementById('config-model-path').value,
        host: document.getElementById('config-host').value,
        port: parseInt(document.getElementById('config-port').value, 10),
        n_gpu_layers: parseInt(document.getElementById('config-gpu-layers').value, 10),
        ctx_size: parseInt(document.getElementById('config-ctx-size').value, 10),
        threads: parseInt(document.getElementById('config-threads').value, 10),
        parallel: parseInt(document.getElementById('config-parallel').value, 10),
        cont_batching: document.getElementById('config-cont-batching').checked,
        mmproj_path: document.getElementById('config-mmproj-path').value,
        extra_args: document.getElementById('config-extra-args').value,
        advanced_args: linesFromTextarea('config-advanced-args'),
        env_vars: envVarsFromTextarea('config-env-vars'),
        preset: document.getElementById('config-preset').value || 'custom',
    };
}

function updateCommandPreview() {
    const preview = document.getElementById('command-preview');
    if (!preview) return;
    const data = formConfigData();
    const cmd = [
        'llama-server',
        '--model', shellQuote(data.model_path || '/path/to/model.gguf'),
        '--host', shellQuote(data.host || '127.0.0.1'),
        '--port', data.port || 8080,
        '--n-gpu-layers', data.n_gpu_layers ?? -1,
        '--ctx-size', data.ctx_size || 4096,
        '--threads', data.threads || 4,
        '--parallel', data.parallel || 1,
        data.cont_batching ? '--cont-batching' : '',
        data.mmproj_path ? `--mmproj ${shellQuote(data.mmproj_path)}` : '',
        ...(data.advanced_args || []),
        data.extra_args || '',
    ].filter(Boolean).join(' ');
    preview.textContent = cmd;
}

function linesFromTextarea(id) {
    return document.getElementById(id).value.split('\n').map(line => line.trim()).filter(Boolean);
}

function envVarsFromTextarea(id) {
    const env = {};
    for (const line of linesFromTextarea(id)) {
        const idx = line.indexOf('=');
        if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return env;
}

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
    overlay.addEventListener('click', e => {
        if (e.target === overlay) overlay.remove();
    });
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('show')));
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 350);
    }, 3500);
}

async function copyText(text, successMessage) {
    try {
        await navigator.clipboard.writeText(text);
        showToast(successMessage, 'success');
    } catch {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
        showToast(successMessage, 'success');
    }
}

function numberOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function formatVram(used, total) {
    if (used == null && total == null) return 'n/a';
    if (used != null && total != null) return `${formatMb(used)} / ${formatMb(total)}`;
    if (used != null) return `${formatMb(used)} used`;
    return `${formatMb(total)} total`;
}

function formatMb(value) {
    if (value >= 1024) return `${(value / 1024).toFixed(value >= 10240 ? 0 : 1)} GB`;
    return `${Math.round(value)} MB`;
}

function formatPower(draw, limit) {
    if (draw == null && limit == null) return 'n/a';
    if (draw != null && limit != null) return `${draw.toFixed(0)} / ${limit.toFixed(0)} W`;
    if (draw != null) return `${draw.toFixed(0)} W`;
    return `${limit.toFixed(0)} W max`;
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}

function shellQuote(value) {
    const text = String(value ?? '');
    return /^[A-Za-z0-9_./:=+-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}

function serverUrl(config) {
    return `http://${config.host}:${config.port}`;
}

function relativeTime(iso) {
    if (!iso) return 'Never';
    const diff = Date.now() - new Date(iso).getTime();
    if (Number.isNaN(diff)) return 'Unknown';
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
}

function labelForHealth(health) {
    return {
        healthy: 'Healthy',
        loading: 'Loading',
        unreachable: 'Unreachable',
        stopped: 'Stopped',
        running: 'Running',
    }[health] || 'Unknown';
}

function option(value, label, selected) {
    return `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`;
}

function serverIcon(size) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/></svg>`;
}

function gearIcon(size) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
}

function terminalIcon(size) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`;
}

function plusIcon(size) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
}

function playIcon(size) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg>`;
}

function stopIcon(size) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>`;
}

function editIcon(size) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
}

function trashIcon(size) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
}

function copyIcon(size) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
}

function restartIcon(size) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`;
}

function downloadIcon(size) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
}

function uploadIcon(size) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
}

initRouter();
