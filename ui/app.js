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
let terminalRequestId = 0;
let terminalPaused = false;
let terminalAutoScroll = true;
let terminalLines = [];
let hubFilter = '';
let hubStateFilter = 'all';
let hubVisionOnly = false;
let hubView = readPreference('hub-view', 'cards');
let selectedConfigId = readPreference('selected-config', '');
let renderVersion = 0;
let renderedPage = '';
let hubPollVersion = 0;
let benchmarkPollVersion = 0;
let serverDataLoaded = false;
let connectionRetryTimer = null;
const connectionErrors = new Map();
const requestVersions = new Map();
const pageStates = new Map();
const chatDrafts = new Map();
const pendingServerActions = new Map();
const dialogStack = [];
const pageLabels = {hub: 'Overview', configs: 'Configurations', terminal: 'Terminal', chat: 'Chat', benchmark: 'Benchmark', 'token-calculator': 'Token usage', settings: 'Settings'};
let modelPathOptions = [];
let modelPathOptionsDirectory = '';
let modelPathActiveIndex = -1;
let tokenCalculatorConfigId = '';
let tokenCalculatorInputPrice = '';
let tokenCalculatorOutputPrice = '';
let tokenCalculatorMagnitude = '1000000';
let chatConfigId = '';
let chatMessagesByConfig = {};
let chatSending = false;
// The in-flight streamed reply: { configId, message, controller, frame }.
let chatStream = null;
let benchmarkOverview = { available: false, binary_path: null, active: null, history: [] };
let benchmarkPoller = null;
let benchmarkConfigId = '';
let benchmarkDraft = null;
let benchmarkSelectedRunId = '';
let chatRequestSettings = {
    // Reasoning models often spend 1-3k tokens thinking before they answer.
    maxTokens: '4096',
    temperature: '0.7',
    topP: '0.95',
    presencePenalty: '0',
    frequencyPenalty: '0',
    seed: '',
    systemPrompt: '',
    stopSequences: '',
    includeHistory: true,
};

function navigate(page) {
    capturePageState();
    stopHubPoller();
    stopBenchmarkPoller();
    stopTerminalPoller();
    currentPage = Object.hasOwn(pageLabels, page) ? page : 'hub';
    document.querySelectorAll('.nav-item').forEach(el => {
        const active = el.dataset.page === currentPage;
        el.classList.toggle('active', active);
        if (active) el.setAttribute('aria-current', 'page');
        else el.removeAttribute('aria-current');
    });
    document.getElementById('page-label').textContent = pageLabels[currentPage];
    render();
}

function initRouter() {
    if (selectedConfigId) rememberConfig(selectedConfigId);
    document.querySelector('.skip-link')?.addEventListener('click', event => {
        event.preventDefault();
        document.getElementById('main-content').focus();
    });
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
    const response = await res.json().catch(() => ({detail: res.statusText}));
    const detail = response.detail;
    const error = new Error(Array.isArray(detail) ? detail.map(item => item.msg).join('; ') : detail || 'Request failed');
    error.fields = Array.isArray(detail) ? detail : [];
    return error;
}

async function fetchResource(name, path, apply) {
    const version = (requestVersions.get(name) || 0) + 1;
    requestVersions.set(name, version);
    try {
        const data = await apiGet(path);
        if (requestVersions.get(name) !== version) return;
        apply(data);
        connectionErrors.delete(name);
    } catch (error) {
        if (requestVersions.get(name) !== version) return;
        connectionErrors.set(name, error.message);
    }
    updateConnectionNotice();
}

async function fetchServers() {
    await fetchResource('servers', '/configs', data => {
        servers = data;
        serverDataLoaded = true;
        if (!servers.some(server => server.config.id === selectedConfigId)) {
            rememberConfig((servers.find(server => server.running) || servers[0])?.config.id || '');
        }
    });
}

async function fetchGpus() {
    await fetchResource('GPU telemetry', '/gpus', data => { gpus = data; });
}

async function fetchRam() {
    await fetchResource('RAM telemetry', '/ram', data => { ram = data; });
}

async function fetchPresets() {
    if (presets.length) return;
    await fetchResource('presets', '/presets', data => { presets = data; });
}

async function fetchSettings() {
    if (settings && !connectionErrors.has('settings')) return;
    await fetchResource('settings', '/settings', data => { settings = data; });
}

async function fetchBenchmarks() {
    await fetchResource('benchmarks', '/benchmarks', data => { benchmarkOverview = data; });
}

function updateConnectionNotice() {
    const notice = document.getElementById('connection-notice');
    const indicator = document.getElementById('connection-indicator');
    if (!notice || !indicator) return;
    const offline = connectionErrors.has('servers');
    indicator.classList.toggle('offline', offline);
    indicator.innerHTML = `<span class="status-dot"></span>${offline ? 'Reconnecting' : serverDataLoaded ? 'Connected locally' : 'Connecting'}`;
    const message = offline
        ? `Connection lost — retrying. ${serverDataLoaded ? 'Showing the last known server status.' : 'Your saved configurations will appear when the connection returns.'}`
        : connectionErrors.size ? `${[...connectionErrors.keys()].join(', ')} unavailable. Retrying…` : '';
    notice.hidden = !message;
    notice.innerHTML = message ? `<span>${escapeHtml(message)}</span><button class="btn btn-ghost btn-sm" id="retry-connection">Retry now</button>` : '';
    notice.querySelector('#retry-connection')?.addEventListener('click', () => render());
    if (connectionErrors.size && !connectionRetryTimer) {
        connectionRetryTimer = setTimeout(() => {
            connectionRetryTimer = null;
            render();
        }, 5000);
    } else if (!connectionErrors.size && connectionRetryTimer) {
        clearTimeout(connectionRetryTimer);
        connectionRetryTimer = null;
    }
}

async function render() {
    if (renderedPage === currentPage) capturePageState();
    const page = currentPage;
    const version = ++renderVersion;
    const main = document.getElementById('main-content');
    stopHubPoller();
    stopBenchmarkPoller();
    if (page !== 'terminal') stopTerminalPoller();
    main.setAttribute('aria-busy', 'true');
    if (renderedPage !== page || !main.children.length) {
        main.innerHTML = `<div class="page-loading" role="status"><div class="loading-mark"></div><p>Loading ${escapeHtml(pageLabels[page].toLowerCase())}…</p><div class="skeleton-grid"><div></div><div></div><div></div></div></div>`;
    }
    const requests = [fetchServers(), fetchSettings(), fetchPresets()];
    if (page === 'hub' || connectionErrors.has('GPU telemetry')) requests.push(fetchGpus());
    if (page === 'hub' || connectionErrors.has('RAM telemetry')) requests.push(fetchRam());
    if (page === 'benchmark' || connectionErrors.has('benchmarks')) requests.push(fetchBenchmarks());
    await Promise.all(requests);
    if (version !== renderVersion || page !== currentPage) return;
    // Capture edits made while this refresh was in flight.
    if (renderedPage === page && !main.querySelector('.page-loading')) capturePageState();
    if (!serverDataLoaded) {
        main.innerHTML = `<div class="empty-state connection-empty"><div class="empty-state-icon">${serverIcon(30)}</div><h1>Waiting for your workspace</h1><p>We’re reconnecting to LLM Hub. Your saved models haven’t been changed.</p><button class="btn btn-primary" id="retry-workspace">Try again</button></div>`;
        document.getElementById('retry-workspace').onclick = () => render();
    } else {
        const views = {hub: [renderHubPage, bindHubEvents], configs: [renderConfigsPage, bindConfigEvents], terminal: [renderTerminalPage, bindTerminalEvents], chat: [renderChatPage, bindChatEvents], benchmark: [renderBenchmarkPage, bindBenchmarkEvents], 'token-calculator': [renderTokenCalculatorPage, bindTokenCalculatorEvents], settings: [renderSettingsPage, bindSettingsEvents]};
        const [view, bind] = views[page];
        main.innerHTML = view();
        restorePageState(page);
        bind();
    }
    renderedPage = page;
    main.setAttribute('aria-busy', 'false');
    if (page === 'hub') startHubPoller();
    if (page === 'benchmark') startBenchmarkPoller();
}

function startHubPoller() {
    const version = ++hubPollVersion;
    const poll = async () => {
        await Promise.all([fetchServers(), fetchGpus(), fetchRam()]);
        if (version !== hubPollVersion || currentPage !== 'hub') return;
        refreshHubSurface();
        serverPoller = setTimeout(poll, settings?.refresh_interval_ms || 3000);
    };
    serverPoller = setTimeout(poll, settings?.refresh_interval_ms || 3000);
}

function stopHubPoller() {
    hubPollVersion += 1;
    clearTimeout(serverPoller);
    serverPoller = null;
}

function startBenchmarkPoller() {
    if (!benchmarkOverview.active || benchmarkPoller) return;
    const version = ++benchmarkPollVersion;
    const poll = async () => {
        await fetchBenchmarks();
        if (version !== benchmarkPollVersion || currentPage !== 'benchmark') return;
        refreshBenchmarkSurface();
        benchmarkPoller = benchmarkOverview.active ? setTimeout(poll, 1000) : null;
    };
    benchmarkPoller = setTimeout(poll, 1000);
}

function stopBenchmarkPoller() {
    benchmarkPollVersion += 1;
    clearTimeout(benchmarkPoller);
    benchmarkPoller = null;
}

function readPreference(key, fallback) {
    try { return localStorage.getItem(`llmhub-${key}`) || fallback; } catch { return fallback; }
}

function writePreference(key, value) {
    try { localStorage.setItem(`llmhub-${key}`, value); } catch { /* Storage can be disabled. */ }
}

function rememberConfig(id) {
    selectedConfigId = id;
    chatConfigId = id;
    currentTerminalServerId = id;
    benchmarkConfigId = id;
    tokenCalculatorConfigId = id;
    writePreference('selected-config', id);
}

function openServerPage(id, page) {
    capturePageState();
    rememberConfig(id);
    if (page === 'benchmark') benchmarkDraft = null;
    location.hash = page;
    if (currentPage === page) render();
}

function capturePageState() {
    if (!renderedPage) return;
    const main = document.getElementById('main-content');
    if (!main || main.querySelector('.page-loading')) return;
    const fields = {};
    main.querySelectorAll('input[id], select[id], textarea[id]').forEach(input => {
        if (['chat-server-select', 'terminal-server-select', 'benchmark-config', 'token-calculator-server', 'chat-input'].includes(input.id)) return;
        fields[input.id] = {value: input.value, checked: input.checked};
    });
    const focus = main.contains(document.activeElement) ? document.activeElement : null;
    const scroll = [...main.querySelectorAll('.chat-window, .terminal-window, .benchmark-log, .benchmark-history-list, .server-table-wrap')].map(el => ({className: el.className, top: el.scrollTop, left: el.scrollLeft}));
    pageStates.set(renderedPage, {fields, scroll, y: window.scrollY, focus: focus?.id, start: focus?.selectionStart, end: focus?.selectionEnd});
    if (renderedPage === 'chat') {
        const input = document.getElementById('chat-input');
        if (input) chatDrafts.set(document.querySelector('.chat-panel')?.dataset.configId || chatConfigId, input.value);
    }
}

function restorePageState(page) {
    const state = pageStates.get(page);
    if (!state) return;
    Object.entries(state.fields).forEach(([id, field]) => {
        const input = document.getElementById(id);
        if (!input || input.disabled) return;
        input.value = field.value;
        if (input.type === 'checkbox') input.checked = field.checked;
    });
    state.scroll.forEach(saved => {
        const el = document.getElementsByClassName(saved.className)[0];
        if (el) { el.scrollTop = saved.top; el.scrollLeft = saved.left; }
    });
    const focus = !dialogStack.length && state.focus ? document.getElementById(state.focus) : null;
    focus?.focus({preventScroll: true});
    if (focus && state.start != null && ['text', 'search', 'textarea'].includes(focus.type)) focus.setSelectionRange(state.start, state.end);
    window.scrollTo({top: state.y, behavior: 'instant'});
}

function replaceSurface(id, html) {
    const surface = document.getElementById(id);
    if (!surface || surface.innerHTML === html) return;
    const active = surface.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
    const openMenus = [...surface.querySelectorAll('details[open][data-menu-id]')].map(el => el.dataset.menuId);
    const scroll = [...surface.querySelectorAll('.server-table-wrap, .benchmark-log, .benchmark-history-list')].map(el => ({className: el.className, top: el.scrollTop, left: el.scrollLeft}));
    surface.innerHTML = html;
    surface.querySelectorAll('details[data-menu-id]').forEach(el => { el.open = openMenus.includes(el.dataset.menuId); });
    if (active) [...surface.querySelectorAll('[data-focus-key]')].find(el => el.dataset.focusKey === active)?.focus({preventScroll: true});
    scroll.forEach(saved => {
        const el = surface.getElementsByClassName(saved.className)[0];
        if (el) { el.scrollTop = saved.top; el.scrollLeft = saved.left; }
    });
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
        const matchesVision = !hubVisionOnly || isVisionConfig(c);
        return matchesText && matchesState && matchesVision;
    });
}

function isVisionConfig(config) {
    return Boolean(config.mmproj_path?.trim());
}

function renderToolbar() {
    return `<div class="toolbar hub-toolbar">
        <div class="search-field">${searchIcon(18)}<input class="toolbar-search" id="hub-filter" type="search" aria-label="Search servers" placeholder="Search models, names, or ports…" value="${escapeHtml(hubFilter)}"></div>
        <select class="toolbar-select" id="hub-state-filter" aria-label="Filter by server status">
            ${option('all', 'All states', hubStateFilter)}${option('running', 'Running', hubStateFilter)}${option('stopped', 'Stopped', hubStateFilter)}${option('healthy', 'Healthy', hubStateFilter)}${option('loading', 'Loading', hubStateFilter)}${option('unreachable', 'Unreachable', hubStateFilter)}
        </select>
        <button class="toolbar-toggle" id="hub-vision-filter" aria-pressed="${hubVisionOnly}" title="Show only configs with a vision projector (mmproj)">${eyeIcon(16)}<span>Vision only</span></button>
        <div class="view-switch" role="group" aria-label="Server layout">
            <button class="view-option" data-view="cards" aria-pressed="${hubView !== 'table'}" title="Card view">${gridIcon(16)}<span>Cards</span></button>
            <button class="view-option" data-view="table" aria-pressed="${hubView === 'table'}" title="Table view">${listIcon(16)}<span>Table</span></button>
        </div>
    </div>`;
}

function renderHubPage() {
    return `<div class="page-header overview-header">
        <div><span class="eyebrow">Your local AI workspace</span><h1>Server overview</h1><p class="subtitle">Your models, resources, and next conversation.</p></div>
        <button class="btn btn-primary" id="hub-new-config">${plusIcon(16)} New configuration</button>
    </div>
    <div id="hub-resources">${renderResourceSection()}</div>
    <div class="collection-heading"><h2>Model library <span class="count-pill" id="server-count">${servers.length}</span></h2><span id="running-count" class="collection-caption">${servers.filter(s => s.running).length} running</span></div>
    ${renderToolbar()}<div id="hub-results">${renderHubResults()}</div>`;
}

function renderHubResults() {
    if (!serverDataLoaded && connectionErrors.has('servers')) return '<div class="empty-state"><h3>Waiting for connection</h3><p>Your configurations will appear when the workspace reconnects.</p></div>';
    if (!servers.length) return `<div class="empty-state"><div class="empty-state-icon">${serverIcon(32)}</div><h3>A home for your models</h3><p>Add your first GGUF configuration to start a server, test a prompt, and follow its performance.</p><button class="btn btn-primary" data-action="new">${plusIcon(16)} Add a model</button></div>`;
    const visible = filteredServers();
    if (!visible.length) return '<div class="empty-state"><h3>No matching models</h3><p>Try another name or clear your filters.</p><button class="btn btn-ghost" data-action="reset-filter">Clear filters</button></div>';
    const groups = [['Running', visible.filter(s => s.running)], ['Stopped', visible.filter(s => !s.running)]];
    return groups.filter(([, items]) => items.length).map(([label, items]) => `<section class="server-section" aria-label="${label} servers"><div class="server-section-heading"><span class="status-dot ${label.toLowerCase()}"></span><h3>${label}</h3><span>${items.length}</span></div>${hubView === 'table' ? renderServerTable(items) : `<div class="server-grid">${items.map(renderServerCard).join('')}</div>`}</section>`).join('');
}

function renderResourceSection() {
    if (!gpus.length && !ram) return '<div class="resource-summary resource-placeholder"><span class="status-dot"></span>Hardware telemetry appears here when available.</div>';
    const metrics = [];
    if (ram) metrics.push(renderResourceMetric('System memory', formatVram(ram.used_mb, ram.total_mb), ram.percent_used, `${formatMb(ram.available_mb)} available`, serverIcon(18)));
    gpus.forEach(gpu => metrics.push(renderResourceMetric(gpu.name || `GPU ${gpu.index}`, formatVram(gpu.vram_used_mb, gpu.vram_total_mb), gpu.gpu_util_percent, `${gpu.gpu_util_percent ?? '—'}% load · ${gpu.temperature_c ?? '—'}°C`, chipIcon(18))));
    return `<div class="resource-summary" aria-label="System resources">${metrics.join('')}</div>`;
}

function renderResourceMetric(title, value, percent, detail, icon) {
    return `<div class="resource-metric"><div class="metric-symbol">${icon}</div><div class="metric-content"><div class="metric-heading"><span title="${escapeHtml(title)}">${escapeHtml(title)}</span><strong>${escapeHtml(value)}</strong></div><div class="metric-bottom"><div class="resource-meter"><span style="width:${Math.max(0, Math.min(100, percent || 0))}%"></span></div><span>${escapeHtml(detail)}</span></div></div></div>`;
}

function serverActionButton(server, action, label, icon, className = 'btn btn-ghost btn-sm') {
    const id = escapeHtml(server.config.id);
    const pending = pendingServerActions.get(server.config.id);
    const busy = ['start', 'stop', 'restart'].includes(action) && pending;
    return `<button class="${className}" data-action="${action}" data-id="${id}" data-focus-key="${id}-${action}" ${busy ? 'disabled aria-busy="true"' : ''}>${icon}${busy && pending === action ? 'Working…' : label}</button>`;
}

function renderServerActions(server) {
    const external = server.running && server.pid == null;
    return `${server.running ? serverActionButton(server, 'stop', external ? 'Untrack' : 'Stop', stopIcon(14), 'btn btn-stop btn-sm') : serverActionButton(server, 'start', 'Start', playIcon(14), 'btn btn-primary btn-sm')}
        ${serverActionButton(server, 'chat', 'Chat', chatIcon(14))}
        ${serverActionButton(server, 'logs', 'Logs', terminalIcon(14))}
        <details class="action-menu" data-menu-id="${escapeHtml(server.config.id)}"><summary class="btn btn-ghost btn-icon btn-sm" aria-label="More actions for ${escapeHtml(server.config.name)}" data-focus-key="${escapeHtml(server.config.id)}-more" title="More actions">${moreIcon(18)}</summary><div class="action-menu-items">
            ${serverActionButton(server, 'details', 'Model details', serverIcon(14))}
            ${server.running ? serverActionButton(server, 'restart', 'Restart server', restartIcon(14)) : ''}
            ${serverActionButton(server, 'copy-url', 'Copy server URL', copyIcon(14))}
            ${serverActionButton(server, 'test', 'Test endpoint', checkIcon(14))}
            ${serverActionButton(server, 'quick-benchmark', 'Quick benchmark', benchmarkIcon(14))}
            ${serverActionButton(server, 'benchmark', 'Open benchmarks', benchmarkIcon(14))}
        </div></details>`;
}

function renderServerCard(server) {
    const c = server.config;
    const health = server.health || (server.running ? 'running' : 'stopped');
    const usage = tokenUsage(server);
    const warning = server.failure_summary || server.validation_warnings?.[0];
    return `<article class="server-card ${health}" data-id="${escapeHtml(c.id)}">
        <div class="card-header"><div class="model-identity"><span class="model-avatar">${escapeHtml(c.name.slice(0, 2).toUpperCase())}</span><div><h3 class="card-title">${escapeHtml(c.name)}</h3><div class="card-subtitle" title="${escapeHtml(c.model_path)}">${escapeHtml(c.model_path.split('/').pop())}</div></div></div><span class="card-status ${health}" title="${escapeHtml(server.status_detail || health)}"><span class="status-dot"></span>${labelForHealth(health)}</span></div>
        <div class="card-address">${serverIcon(13)}<span>${escapeHtml(c.host)}:${c.port}</span>${server.model_size_label ? `<span class="model-size">${escapeHtml(server.model_size_label)}</span>` : ''}</div>
        <div class="card-details">
            <div class="card-detail"><span class="label">Context window</span><span class="value">${formatTokens(c.ctx_size)} <small>tokens</small></span></div>
            <div class="card-detail"><span class="label">Output limit</span><span class="value">${formatOutputLimit(c.n_predict)}</span></div>
            <div class="card-detail"><span class="label">GPU offload</span><span class="value">${c.n_gpu_layers === -1 ? 'All layers' : `${c.n_gpu_layers} layers`}</span></div>
            <div class="card-detail"><span class="label">CPU threads</span><span class="value">${c.threads}</span></div>
        </div>
        ${warning ? `<div class="card-warning">${escapeHtml(warning)}</div>` : ''}
        ${health === 'loading' ? `<div class="startup-note"><span class="loading-mark small"></span>Loading model${server.startup_elapsed_seconds != null ? ` · ${server.startup_elapsed_seconds}s` : ''}</div>` : ''}
        <div class="card-usage"><span>Tokens used</span><span title="Input tokens used">${formatTokens(usage.prompt_tokens)} in</span><span title="Output tokens used">${formatTokens(usage.completion_tokens)} out</span></div>
        <div class="card-actions">${renderServerActions(server)}</div>
    </article>`;
}

function renderServerTable(items) {
    return `<div class="server-table-wrap" tabindex="0" aria-label="Scrollable server table"><table class="server-table"><thead><tr><th scope="col">Model</th><th scope="col">Status</th><th scope="col">Context</th><th scope="col">Output limit</th><th scope="col">Tokens used</th><th scope="col">Actions</th></tr></thead><tbody>${items.map(server => `<tr><td><strong>${escapeHtml(server.config.name)}</strong><small>${escapeHtml(server.config.host)}:${server.config.port}</small></td><td><span class="card-status ${server.health}"><span class="status-dot"></span>${labelForHealth(server.health)}</span></td><td>${formatTokens(server.config.ctx_size)}</td><td>${formatOutputLimit(server.config.n_predict)}</td><td>${formatTokens(tokenUsage(server).total_tokens)}</td><td><div class="table-actions">${renderServerActions(server)}</div></td></tr>`).join('')}</tbody></table></div>`;
}

function refreshHubSurface() {
    if (currentPage !== 'hub') return;
    replaceSurface('hub-resources', renderResourceSection());
    replaceSurface('hub-results', renderHubResults());
    const count = document.getElementById('server-count');
    if (count) count.textContent = servers.length;
    const running = document.getElementById('running-count');
    if (running) running.textContent = `${servers.filter(s => s.running).length} running`;
}

function bindHubEvents() {
    bindToolbar();
    document.getElementById('hub-new-config').onclick = () => openModal();
    document.getElementById('hub-results').onclick = async event => {
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        const action = button.dataset.action;
        if (action === 'new') return openModal();
        if (action === 'reset-filter') {
            hubFilter = ''; hubStateFilter = 'all'; hubVisionOnly = false;
            document.getElementById('hub-filter').value = '';
            document.getElementById('hub-state-filter').value = 'all';
            document.getElementById('hub-vision-filter').setAttribute('aria-pressed', 'false');
            return refreshHubSurface();
        }
        const id = button.dataset.id;
        const server = servers.find(item => item.config.id === id);
        if (!server) return;
        const menu = button.closest('details');
        if (menu) { menu.open = false; menu.querySelector('summary').focus(); }
        if (action === 'chat' || action === 'logs' || action === 'benchmark') return openServerPage(id, action === 'logs' ? 'terminal' : action);
        if (action === 'details') return showDetails(id);
        if (action === 'copy-url') return copyText(serverUrl(server.config), 'Server URL copied');
        if (action === 'test') return testEndpoint(id);
        if (action === 'quick-benchmark') return benchmarkEndpoint(id);
        if (!['start', 'stop', 'restart'].includes(action) || pendingServerActions.has(id)) return;
        pendingServerActions.set(id, action);
        refreshHubSurface();
        try {
            await apiPost(`/configs/${encodeURIComponent(id)}/${action}`);
            showToast(action === 'stop' ? 'Server stopped or untracked' : 'Server is starting', 'success');
        } catch (error) { showToast(error.message, 'error'); }
        finally {
            pendingServerActions.delete(id);
            await fetchServers();
            refreshHubSurface();
        }
    };
}

function bindToolbar() {
    document.getElementById('hub-filter')?.addEventListener('input', event => { hubFilter = event.target.value; refreshHubSurface(); });
    document.getElementById('hub-state-filter')?.addEventListener('change', event => { hubStateFilter = event.target.value; refreshHubSurface(); });
    document.getElementById('hub-vision-filter')?.addEventListener('click', event => {
        hubVisionOnly = !hubVisionOnly;
        event.currentTarget.setAttribute('aria-pressed', String(hubVisionOnly));
        refreshHubSurface();
    });
    document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
        hubView = button.dataset.view;
        writePreference('hub-view', hubView);
        document.querySelectorAll('[data-view]').forEach(item => item.setAttribute('aria-pressed', String(item.dataset.view === hubView)));
        refreshHubSurface();
    }));
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
                        <span>Context: ${formatTokens(c.ctx_size)}</span>
                        <span>Output limit: ${formatOutputLimit(c.n_predict)}</span>
                        <span>Updated: ${relativeTime(c.updated_at)}</span>
                    </div>
                </div>
                <div class="config-item-actions">
                    <button class="btn btn-ghost btn-sm edit-btn" data-id="${escapeHtml(c.id)}" ${locked}>${editIcon(14)} Edit</button>
                    <button class="btn btn-ghost btn-sm duplicate-btn" data-id="${escapeHtml(c.id)}">${copyIcon(14)} Duplicate</button>
                    <details class="action-menu"><summary class="btn btn-ghost btn-icon btn-sm" title="More actions" aria-label="More actions for ${escapeHtml(c.name)}">${moreIcon(18)}</summary><div class="action-menu-items">
                        <button class="btn btn-ghost btn-sm copy-command-btn" data-id="${escapeHtml(c.id)}">${copyIcon(14)} Copy command</button>
                        <button class="btn btn-ghost btn-sm export-one-btn" data-id="${escapeHtml(c.id)}">${downloadIcon(14)} Export JSON</button>
                        <button class="btn btn-danger btn-sm delete-btn" data-id="${escapeHtml(c.id)}" data-name="${escapeHtml(c.name)}" ${locked}>${trashIcon(14)} Delete configuration</button>
                    </div></details>
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
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `<div class="confirm-dialog scan-directory-dialog"><h3>Discover local models</h3><p>Choose a folder to scan for GGUF models and vision projectors.</p><form id="scan-directory-form"><div class="form-group"><label for="scan-directory">Model folder</label><input id="scan-directory" type="text" value="${escapeHtml(settings?.model_scan_directory || '')}" placeholder="/path/to/models" required><span class="field-error" id="scan-directory-error" role="alert"></span></div><div class="confirm-actions"><button type="button" class="btn btn-ghost confirm-cancel">Cancel</button><button type="submit" class="btn btn-primary">Scan folder</button></div></form></div>`;
    document.body.appendChild(overlay);
    activateDialog(overlay, () => dismissDialog(overlay));
    overlay.querySelector('.confirm-cancel').onclick = () => dismissDialog(overlay);
    overlay.querySelector('form').onsubmit = async event => {
        event.preventDefault();
        const button = overlay.querySelector('[type="submit"]');
        const error = overlay.querySelector('#scan-directory-error');
        button.disabled = true; button.textContent = 'Scanning…'; error.textContent = '';
        try {
            const directory = overlay.querySelector('#scan-directory').value.trim();
            const results = await apiGet(`/models/scan?directory=${encodeURIComponent(directory)}`);
            if (!overlay.isConnected) return;
            const models = results.filter(item => item.kind === 'model');
            if (!models.length) { error.textContent = 'No models found. Try another folder.'; return; }
            dismissDialog(overlay);
            showScannerPreview(models, results.filter(item => item.kind === 'mmproj'));
        } catch (failure) { error.textContent = failure.message; }
        finally { button.disabled = false; button.textContent = 'Scan folder'; }
    };
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
    activateDialog(overlay, () => dismissDialog(overlay));
    overlay.querySelector('.confirm-cancel').addEventListener('click', () => dismissDialog(overlay));
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
        dismissDialog(overlay);
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
    const usage = tokenUsage(server);
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
                <dt>Output token limit</dt><dd>${formatOutputLimit(c.n_predict)}</dd>
                <dt>Health</dt><dd>${escapeHtml(labelForHealth(server.health))}${server.status_detail ? ` - ${escapeHtml(server.status_detail)}` : ''}</dd>
                <dt>Startup</dt><dd>${server.startup_elapsed_seconds ?? 'n/a'} seconds</dd>
                <dt>Input tokens</dt><dd>${formatTokens(usage.prompt_tokens)}</dd>
                <dt>Output tokens</dt><dd>${formatTokens(usage.completion_tokens)}</dd>
                <dt>Total tokens</dt><dd>${formatTokens(usage.total_tokens)}</dd>
                <dt>Tracked requests</dt><dd>${usage.request_count.toLocaleString()}</dd>
                <dt>Last token use</dt><dd>${escapeHtml(relativeTime(usage.last_used_at))}</dd>
                <dt>Chat proxy</dt><dd>${escapeHtml(trackedChatUrl(c))}</dd>
                <dt>Last exit</dt><dd>${server.last_exit_code ?? 'n/a'} ${server.failure_summary ? `- ${escapeHtml(server.failure_summary)}` : ''}</dd>
                <dt>Warnings</dt><dd>${escapeHtml((server.validation_warnings || []).join('; ') || 'None')}</dd>
                <dt>Resource hints</dt><dd>${escapeHtml((server.resource_hints || []).join('; ') || 'None')}</dd>
                <dt>Command</dt><dd>${escapeHtml(server.command_text)}</dd>
            </dl>
            <div class="confirm-actions">
                <button class="btn btn-ghost btn-sm copy-token-url-btn">Copy Proxy URL</button>
                <button class="btn btn-danger btn-sm reset-token-usage-btn">Reset Tokens</button>
                <button class="btn btn-ghost btn-sm confirm-cancel">Close</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    activateDialog(overlay, () => dismissDialog(overlay));
    overlay.querySelector('.confirm-cancel').addEventListener('click', () => dismissDialog(overlay));
    overlay.querySelector('.copy-token-url-btn').addEventListener('click', () => copyText(trackedChatUrl(c), 'Proxy URL copied'));
    overlay.querySelector('.reset-token-usage-btn').addEventListener('click', async () => {
        try {
            await apiPost(`/configs/${configId}/tokens/reset`);
            dismissDialog(overlay);
            showToast('Token usage reset', 'info');
            render();
        } catch (e) {
            showToast('Failed to reset token usage: ' + e.message, 'error');
        }
    });
    overlay.addEventListener('click', e => {
        if (e.target === overlay) dismissDialog(overlay);
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
                <select class="terminal-selector" id="terminal-server-select" aria-label="Terminal server">${options}</select>
                <div class="terminal-status-badge stopped" id="terminal-status">
                    <span class="status-dot"></span> <span id="terminal-status-text">Stopped</span>
                </div>
                <input class="terminal-filter" id="terminal-filter" type="search" aria-label="Filter terminal output" placeholder="Filter output">
                <button class="btn btn-ghost btn-sm" id="terminal-pause-btn">${terminalPaused ? 'Resume' : 'Pause'}</button>
                <button class="btn btn-ghost btn-sm" id="terminal-autoscroll-btn" aria-pressed="${terminalAutoScroll}">Auto-scroll ${terminalAutoScroll ? 'On' : 'Off'}</button>
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

function renderChatPage() {
    const header = `
        <div class="page-header">
            <div>
                <h1>Chat</h1>
                <p class="subtitle">Send a quick test message to a configured model</p>
            </div>
            <div class="header-actions">
                <button class="btn btn-ghost btn-icon" id="chat-settings-btn" title="Chat settings" aria-label="Chat settings">${gearIcon(18)}</button>
            </div>
        </div>`;

    if (servers.length === 0) {
        return header + `
            <div class="empty-state">
                <div class="empty-state-icon">${chatIcon(36)}</div>
                <h3>No Configurations</h3>
                <p>Create a server configuration first to test chat responses.</p>
                <a href="#configs" class="btn btn-primary">Go to Configs</a>
            </div>`;
    }

    if (!servers.some(s => s.config.id === chatConfigId)) {
        chatConfigId = servers[0].config.id;
    }

    const server = chatServer();
    const usage = tokenUsage(server);
    const options = servers.map(s => `<option value="${s.config.id}" ${s.config.id === chatConfigId ? 'selected' : ''}>${escapeHtml(s.config.name)}</option>`).join('');
    const messages = chatMessages();

    return header + `
        <section class="chat-panel" data-config-id="${escapeHtml(chatConfigId)}">
            <div class="chat-toolbar">
                <select class="chat-server-select" id="chat-server-select" aria-label="Chat model">${options}</select>
                <div class="terminal-status-badge ${server?.health || 'stopped'}">
                    <span class="status-dot"></span> ${labelForHealth(server?.health || 'stopped')}
                </div>
                <div class="chat-token-summary">
                    <span>Input ${formatTokens(usage.prompt_tokens)}</span>
                    <span>Output ${formatTokens(usage.completion_tokens)}</span>
                </div>
                <button class="btn btn-ghost btn-sm" id="chat-clear-btn" ${messages.length && !chatSending ? '' : 'disabled'}>Clear</button>
            </div>
            <div class="chat-window" id="chat-window">
                ${renderChatMessages(messages)}
            </div>
            <form class="chat-composer" id="chat-form">
                <textarea id="chat-input" rows="3" aria-label="Message" placeholder="Message the selected model…">${escapeHtml(chatDrafts.get(chatConfigId) || '')}</textarea>
                <button class="btn ${chatSending ? 'btn-danger' : 'btn-primary'}" id="chat-send-btn" type="submit">${chatSending ? 'Stop' : 'Send'}</button>
            </form>
        </section>`;
}

function bindChatEvents() {
    document.getElementById('chat-input')?.addEventListener('input', event => chatDrafts.set(chatConfigId, event.target.value));
    document.getElementById('chat-settings-btn')?.addEventListener('click', openChatSettings);
    document.getElementById('chat-server-select')?.addEventListener('change', e => {
        capturePageState();
        rememberConfig(e.target.value);
        render();
    });
    document.getElementById('chat-clear-btn')?.addEventListener('click', () => {
        chatMessagesByConfig[chatConfigId] = [];
        renderChatOnly();
    });
    document.getElementById('chat-form')?.addEventListener('submit', sendChatMessage);
    // toggle does not bubble, so capture it to remember which thought processes are expanded across re-renders.
    document.getElementById('chat-window')?.addEventListener('toggle', e => {
        const details = e.target;
        if (!details.matches?.('.chat-reasoning')) return;
        // data-expected records the state we set; anything else came from the user.
        if (String(details.open) === details.dataset.expected) return;
        details.dataset.expected = String(details.open);
        const message = chatMessages()[Number(details.dataset.index)];
        if (message) message.reasoningOpen = details.open;
    }, true);
    document.getElementById('chat-input')?.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            // Enter never stops a reply; only the Stop button does.
            if (!chatSending) document.getElementById('chat-form')?.requestSubmit();
        }
    });
    document.getElementById('chat-window')?.addEventListener('click', e => {
        const button = e.target.closest?.('.md-copy');
        if (button) copyText(button.closest('.md-code-block').querySelector('code').textContent, 'Code copied');
    });
    if (!pageStates.has('chat')) scrollChatToBottom();
}

function renderChatMessages(messages) {
    if (!messages.length) {
        return `<div class="chat-empty">No messages yet</div>`;
    }
    return messages.map(renderChatMessage).join('');
}

function renderChatMessage(message, index) {
    const assistant = message.role === 'assistant';
    // Streaming replies always carry the reasoning slot so it can fill in place.
    const reasoning = assistant && (message.reasoning || message.streaming) ? renderChatReasoning(message, index) : '';
    return `
        <div class="chat-message ${message.role} ${message.error ? 'error' : ''} ${message.streaming ? 'streaming' : ''}" data-index="${index}">
            <div class="chat-bubble">
                <div class="chat-role">${assistant ? 'Model' : 'You'}</div>
                ${reasoning}
                ${assistant
                    ? `<div class="chat-answer">${chatAnswerHtml(message)}</div>`
                    : `<div class="chat-content">${escapeHtml(message.content)}</div>`}
            </div>
        </div>
    `;
}

function renderChatReasoning(message, index) {
    const open = chatReasoningOpen(message);
    return `
        <details class="chat-reasoning" data-index="${index}" data-expected="${open}" ${open ? 'open' : ''} ${message.reasoning ? '' : 'hidden'}>
            <summary><span class="chat-reasoning-label">${chatReasoningLabel(message)}</span><span class="chat-reasoning-size">${chatReasoningSize(message)}</span></summary>
            <div class="chat-reasoning-content">${escapeHtml(message.reasoning)}</div>
        </details>`;
}

// Follow the user's choice; otherwise show thinking live and collapse it once the answer starts.
function chatReasoningOpen(message) {
    return message.reasoningOpen ?? (Boolean(message.streaming) && !message.content);
}

function chatReasoningLabel(message) {
    if (message.streaming && !message.content) return 'Thinking…';
    return message.content ? 'Thought process' : 'Thought process (no final answer)';
}

function chatReasoningSize(message) {
    const words = String(message.reasoning || '').split(/\s+/).filter(Boolean).length;
    return `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'}`;
}

function chatAnswerHtml(message) {
    if (message.error) return `<div class="chat-content">${escapeHtml(message.content)}</div>`;
    const notes = [];
    if (message.interrupted) notes.push(`<div class="chat-note error">Connection lost: ${escapeHtml(message.interrupted)}</div>`);
    if (message.stopped) notes.push('<div class="chat-note">Stopped</div>');
    if (message.content) {
        return `<div class="chat-content markdown">${renderMarkdown(message.content)}</div>${notes.join('')}`;
    }
    if (message.streaming) {
        return `<div class="chat-pending">${message.reasoning ? 'Working on an answer' : 'Waiting for the model'}<span class="chat-dots"><span></span><span></span><span></span></span></div>`;
    }
    if (message.reasoning && !message.stopped && !message.interrupted) {
        return `<div class="chat-no-answer">${message.truncated
            ? 'The model used its whole output budget on reasoning and never reached a final answer. Raise Maximum Output Tokens in chat settings and try again.'
            : 'The model returned reasoning but no final answer.'}</div>`;
    }
    return notes.join('') || '<div class="chat-no-answer">The model returned an empty response.</div>';
}

async function sendChatMessage(event) {
    event.preventDefault();
    if (chatSending) {
        // Only the Stop button submits while a reply streams.
        if (event.submitter) chatStream?.controller.abort();
        return;
    }
    if (!chatConfigId) return;

    const input = document.getElementById('chat-input');
    const content = input?.value.trim();
    if (!content) return;

    const configId = chatConfigId;
    const messages = chatMessages();
    messages.push({ role: 'user', content });
    const payload = chatRequestPayload(messages);
    const reply = { role: 'assistant', content: '', reasoning: '', streaming: true };
    messages.push(reply);
    input.value = '';
    chatDrafts.set(configId, '');
    chatStream = { configId, message: reply, controller: new AbortController(), frame: null };
    chatSending = true;
    renderChatOnly();

    try {
        await streamChatCompletion(configId, payload, reply, chatStream.controller.signal);
        if (!reply.content && !reply.reasoning) {
            Object.assign(reply, { content: 'No assistant text found in the response.', error: true });
        }
    } catch (e) {
        if (e.name === 'AbortError') {
            reply.stopped = true;
        } else if (!reply.content && !reply.reasoning) {
            Object.assign(reply, { content: `Request failed: ${e.message}`, error: true });
        } else {
            reply.interrupted = e.message;
        }
    } finally {
        reply.streaming = false;
        chatStream = null;
        chatSending = false;
        renderChatOnly();
    }
    // Usage totals only change once the reply has finished.
    await fetchServers();
    renderChatOnly({ focus: false });
}

async function streamChatCompletion(configId, payload, reply, signal) {
    const res = await fetch(`${API_BASE}/configs/${configId}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // include_usage makes llama.cpp send token counts in the final chunk for the usage tracker.
        body: JSON.stringify({ ...payload, stream: true, stream_options: { include_usage: true } }),
        signal,
    });
    if (!res.ok) throw await chatResponseError(res);

    if (!(res.headers.get('content-type') || '').includes('text/event-stream') || !res.body) {
        // The server ignored stream: true and sent the whole reply at once.
        Object.assign(reply, extractChatReply(await res.json()));
        return;
    }

    const state = { raw: '', separate: '' };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = done ? '' : events.pop();
        for (const event of events) applyChatStreamEvent(event, reply, state);
        if (done) return;
    }
}

function applyChatStreamEvent(event, reply, state) {
    const data = event.split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, ''))
        .join('\n');
    if (!data || data === '[DONE]') return;
    let chunk;
    try {
        chunk = JSON.parse(data);
    } catch {
        return;
    }
    if (chunk.error) throw new Error(chunk.error.message || String(chunk.error));

    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string') state.raw += delta.content;
    const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoningDelta === 'string') state.separate += reasoningDelta;
    if (choice.finish_reason) reply.truncated = choice.finish_reason === 'length';

    // Re-split the whole text each time: a closing </think> can reclassify everything before it.
    const split = splitReasoning(state.raw);
    reply.content = split.content;
    reply.reasoning = [state.separate.trim(), split.reasoning].filter(Boolean).join('\n\n');
    scheduleChatStreamRender();
}

async function chatResponseError(res) {
    const body = await res.json().catch(() => null);
    const detail = typeof body?.detail === 'string' ? body.detail : '';
    return new Error(body?.error?.message || detail || `HTTP ${res.status} ${res.statusText}`.trim());
}

function scheduleChatStreamRender() {
    if (!chatStream || chatStream.frame) return;
    chatStream.frame = requestAnimationFrame(() => {
        if (!chatStream) return;
        chatStream.frame = null;
        updateStreamingMessage();
    });
}

// Patch only the streaming bubble so clicks, selection, and scroll elsewhere survive each token.
function updateStreamingMessage() {
    const stream = chatStream;
    const panel = document.querySelector('.chat-panel');
    if (!stream || !panel || panel.dataset.configId !== stream.configId) return;
    const index = (chatMessagesByConfig[stream.configId] || []).indexOf(stream.message);
    const element = panel.querySelector(`.chat-message[data-index="${index}"]`);
    if (!element) return;

    const message = stream.message;
    const win = panel.querySelector('#chat-window');
    const followChat = win.scrollHeight - win.scrollTop - win.clientHeight < 48;

    const details = element.querySelector('.chat-reasoning');
    if (details) {
        details.hidden = !message.reasoning;
        details.querySelector('.chat-reasoning-label').textContent = chatReasoningLabel(message);
        details.querySelector('.chat-reasoning-size').textContent = chatReasoningSize(message);
        const body = details.querySelector('.chat-reasoning-content');
        const followReasoning = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
        body.textContent = message.reasoning;
        if (followReasoning) body.scrollTop = body.scrollHeight;
        // Skip while a user toggle is still pending so it is not undone.
        const open = chatReasoningOpen(message);
        if (String(details.open) === details.dataset.expected && details.open !== open) {
            details.dataset.expected = String(open);
            details.open = open;
        }
    }
    element.querySelector('.chat-answer').innerHTML = chatAnswerHtml(message);
    if (followChat) win.scrollTop = win.scrollHeight;
}

function renderChatOnly({ focus = true } = {}) {
    const panel = document.querySelector('.chat-panel');
    if (!panel) return;
    const server = chatServer();
    const usage = tokenUsage(server);
    const messages = chatMessages();
    panel.querySelector('.chat-token-summary').innerHTML = `
        <span>Input ${formatTokens(usage.prompt_tokens)}</span>
        <span>Output ${formatTokens(usage.completion_tokens)}</span>`;
    panel.querySelector('#chat-window').innerHTML = renderChatMessages(messages);
    panel.querySelector('#chat-clear-btn').disabled = messages.length === 0 || chatSending;
    const button = panel.querySelector('#chat-send-btn');
    button.textContent = chatSending ? 'Stop' : 'Send';
    button.classList.toggle('btn-danger', chatSending);
    button.classList.toggle('btn-primary', !chatSending);
    scrollChatToBottom();
    if (focus && !chatSending) panel.querySelector('#chat-input').focus();
}

function openChatSettings() {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
        <div class="confirm-dialog chat-settings-dialog">
            <h3>Chat Settings</h3>
            <form id="chat-settings-form">
                <div class="form-grid compact-form-grid">
                    <div class="form-group">
                        <label for="chat-setting-max-tokens">Maximum Output Tokens</label>
                        <input type="number" id="chat-setting-max-tokens" min="1" step="1" value="${escapeHtml(chatRequestSettings.maxTokens)}">
                        <span class="form-hint">Config limit: ${formatOutputLimit(chatServer()?.config.n_predict)}. Smaller request limits still apply.</span>
                    </div>
                    <div class="form-group">
                        <label for="chat-setting-temperature">Temperature</label>
                        <input type="number" id="chat-setting-temperature" min="0" max="2" step="0.01" value="${escapeHtml(chatRequestSettings.temperature)}">
                    </div>
                    <div class="form-group">
                        <label for="chat-setting-top-p">Top P</label>
                        <input type="number" id="chat-setting-top-p" min="0" max="1" step="0.01" value="${escapeHtml(chatRequestSettings.topP)}">
                    </div>
                    <div class="form-group">
                        <label for="chat-setting-seed">Seed</label>
                        <input type="number" id="chat-setting-seed" step="1" placeholder="Random" value="${escapeHtml(chatRequestSettings.seed)}">
                    </div>
                    <div class="form-group">
                        <label for="chat-setting-presence">Presence Penalty</label>
                        <input type="number" id="chat-setting-presence" min="-2" max="2" step="0.01" value="${escapeHtml(chatRequestSettings.presencePenalty)}">
                    </div>
                    <div class="form-group">
                        <label for="chat-setting-frequency">Frequency Penalty</label>
                        <input type="number" id="chat-setting-frequency" min="-2" max="2" step="0.01" value="${escapeHtml(chatRequestSettings.frequencyPenalty)}">
                    </div>
                    <div class="form-group full-width">
                        <label for="chat-setting-system">System Prompt</label>
                        <textarea id="chat-setting-system" rows="3" placeholder="Optional behavior instructions">${escapeHtml(chatRequestSettings.systemPrompt)}</textarea>
                    </div>
                    <div class="form-group full-width">
                        <label for="chat-setting-stop">Stop Sequences</label>
                        <textarea id="chat-setting-stop" rows="3" placeholder="One sequence per line">${escapeHtml(chatRequestSettings.stopSequences)}</textarea>
                    </div>
                    <div class="form-group full-width">
                        <label class="checkbox-label">
                            <input type="checkbox" id="chat-setting-history" ${chatRequestSettings.includeHistory ? 'checked' : ''}>
                            <span class="checkmark"></span>
                            Send prior chat messages with each request
                        </label>
                    </div>
                </div>
                <div class="confirm-actions">
                    <button class="btn btn-ghost btn-sm confirm-cancel" type="button">Cancel</button>
                    <button class="btn btn-primary btn-sm" type="submit">Save</button>
                </div>
            </form>
        </div>`;

    document.body.appendChild(overlay);
    activateDialog(overlay, () => dismissDialog(overlay));
    overlay.querySelector('.confirm-cancel').addEventListener('click', () => dismissDialog(overlay));
    overlay.querySelector('#chat-settings-form').addEventListener('submit', e => {
        e.preventDefault();
        chatRequestSettings = {
            maxTokens: document.getElementById('chat-setting-max-tokens').value || '4096',
            temperature: document.getElementById('chat-setting-temperature').value || '0.7',
            topP: document.getElementById('chat-setting-top-p').value || '0.95',
            presencePenalty: document.getElementById('chat-setting-presence').value || '0',
            frequencyPenalty: document.getElementById('chat-setting-frequency').value || '0',
            seed: document.getElementById('chat-setting-seed').value,
            systemPrompt: document.getElementById('chat-setting-system').value,
            stopSequences: document.getElementById('chat-setting-stop').value,
            includeHistory: document.getElementById('chat-setting-history').checked,
        };
        dismissDialog(overlay);
        showToast('Chat settings saved', 'success');
    });
    overlay.addEventListener('click', e => {
        if (e.target === overlay) dismissDialog(overlay);
    });
}

function chatRequestPayload(messages) {
    const cleanMessages = messages.filter(message => !message.error).map(({ role, content }) => ({ role, content }));
    const requestMessages = chatRequestSettings.includeHistory
        ? cleanMessages
        : cleanMessages.slice(-1);
    const systemPrompt = chatRequestSettings.systemPrompt.trim();
    const payload = {
        messages: systemPrompt ? [{ role: 'system', content: systemPrompt }, ...requestMessages] : requestMessages,
    };

    setNumericPayload(payload, 'max_tokens', chatRequestSettings.maxTokens, { integer: true, min: 1 });
    setNumericPayload(payload, 'temperature', chatRequestSettings.temperature, { min: 0 });
    setNumericPayload(payload, 'top_p', chatRequestSettings.topP, { min: 0, max: 1 });
    setNumericPayload(payload, 'presence_penalty', chatRequestSettings.presencePenalty);
    setNumericPayload(payload, 'frequency_penalty', chatRequestSettings.frequencyPenalty);
    setNumericPayload(payload, 'seed', chatRequestSettings.seed, { integer: true });

    const stop = linesFromText(chatRequestSettings.stopSequences);
    if (stop.length === 1) payload.stop = stop[0];
    if (stop.length > 1) payload.stop = stop;
    return payload;
}

function setNumericPayload(payload, key, rawValue, { integer = false, min = null, max = null } = {}) {
    if (String(rawValue ?? '').trim() === '') return;
    let value = Number(rawValue);
    if (!Number.isFinite(value)) return;
    if (integer) value = Math.trunc(value);
    if (min != null) value = Math.max(min, value);
    if (max != null) value = Math.min(max, value);
    payload[key] = value;
}

function linesFromText(value) {
    return String(value || '').split('\n').map(line => line.trim()).filter(Boolean);
}

function extractChatReply(data) {
    const choice = data?.choices?.[0] || {};
    const message = choice.message || {};
    // llama-server returns reasoning separately when --reasoning-format extracts it;
    // otherwise it stays inline in the content and is split out below.
    const separateReasoning = [message.reasoning_content, message.reasoning].map(contentToText).filter(Boolean);
    const candidates = [
        message.content,
        choice.content,
        choice.text,
        choice.delta?.content,
        data?.message?.content,
        data?.content,
        data?.response,
        data?.text,
    ];

    let content = '';
    let inlineReasoning = '';
    for (const candidate of candidates) {
        const text = contentToText(candidate);
        if (text) {
            ({ content, reasoning: inlineReasoning } = splitReasoning(text));
            break;
        }
    }

    const reasoning = [...separateReasoning, inlineReasoning].filter(Boolean).join('\n\n');
    if (content || reasoning) {
        return { content, reasoning, truncated: choice.finish_reason === 'length', error: false };
    }

    const preview = responsePreview(data);
    return {
        content: preview
            ? `No assistant text found in the response.\n\n${preview}`
            : 'No assistant text found in the response.',
        error: true,
    };
}

// ── Markdown ─────────────────────────────────────────────────────────────
// A small renderer for model answers. All text is escaped before any tags are
// added, and links are limited to http(s), so model output cannot inject HTML.

const MD_FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const MD_HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const MD_RULE = /^ {0,3}([-*_])( *\1){2,} *$/;
const MD_QUOTE = /^ {0,3}> ?/;
const MD_LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const MD_TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function renderMarkdown(text) {
    return renderMarkdownBlocks(String(text ?? '').replace(/\r\n?/g, '\n').split('\n'));
}

function isMarkdownTableStart(lines, i) {
    const divider = lines[i + 1];
    return lines[i].includes('|') && divider !== undefined && divider.includes('|') && divider.includes('-') && MD_TABLE_DIVIDER.test(divider);
}

function startsMarkdownBlock(lines, i) {
    const line = lines[i];
    return MD_FENCE.test(line) || MD_HEADING.test(line) || MD_RULE.test(line) || MD_QUOTE.test(line)
        || MD_LIST_ITEM.test(line) || isMarkdownTableStart(lines, i);
}

function markdownIndent(line) {
    return line.match(/^ */)[0].length;
}

function renderMarkdownBlocks(lines) {
    const html = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) {
            i++;
            continue;
        }

        const fence = line.match(MD_FENCE);
        if (fence) {
            const closing = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
            const code = [];
            i++;
            while (i < lines.length && !closing.test(lines[i])) code.push(lines[i++]);
            i++; // closing fence; an unclosed fence (mid-stream) runs to the end
            const lang = fence[2] ? `<span class="md-lang">${escapeHtml(fence[2])}</span>` : '';
            html.push(`<div class="md-code-block"><div class="md-code-bar">${lang}<button class="md-copy" type="button">Copy</button></div><pre><code>${escapeHtml(code.join('\n'))}</code></pre></div>`);
            continue;
        }

        const heading = line.match(MD_HEADING);
        if (heading) {
            const level = heading[1].length;
            html.push(`<h${level} class="md-heading">${renderInlineMarkdown(heading[2])}</h${level}>`);
            i++;
            continue;
        }

        if (MD_RULE.test(line)) {
            html.push('<hr>');
            i++;
            continue;
        }

        if (MD_QUOTE.test(line)) {
            const quoted = [];
            while (i < lines.length && MD_QUOTE.test(lines[i])) quoted.push(lines[i++].replace(MD_QUOTE, ''));
            html.push(`<blockquote>${renderMarkdownBlocks(quoted)}</blockquote>`);
            continue;
        }

        if (isMarkdownTableStart(lines, i)) {
            const aligns = splitMarkdownRow(lines[i + 1]).map(cell => {
                if (cell.startsWith(':') && cell.endsWith(':')) return 'center';
                if (cell.endsWith(':')) return 'right';
                return cell.startsWith(':') ? 'left' : '';
            });
            const cellHtml = (tag, cells) => cells.map((cell, col) => {
                const align = aligns[col] ? ` style="text-align:${aligns[col]}"` : '';
                return `<${tag}${align}>${renderInlineMarkdown(cell)}</${tag}>`;
            }).join('');
            const header = splitMarkdownRow(lines[i]);
            i += 2;
            const rows = [];
            while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(splitMarkdownRow(lines[i++]));
            html.push(`<div class="md-table-wrap"><table><thead><tr>${cellHtml('th', header)}</tr></thead><tbody>${rows.map(row => `<tr>${cellHtml('td', row)}</tr>`).join('')}</tbody></table></div>`);
            continue;
        }

        const item = line.match(MD_LIST_ITEM);
        if (item) {
            const [list, next] = collectMarkdownList(lines, i, item);
            html.push(list);
            i = next;
            continue;
        }

        // Paragraph. Chat models use single newlines as line breaks, so keep them.
        const paragraph = [lines[i++].trim()];
        while (i < lines.length && lines[i].trim() && !startsMarkdownBlock(lines, i)) paragraph.push(lines[i++].trim());
        html.push(`<p>${paragraph.map(renderInlineMarkdown).join('<br>')}</p>`);
    }
    return html.join('');
}

function collectMarkdownList(lines, start, firstItem) {
    const ordered = /\d/.test(firstItem[2]);
    const baseIndent = firstItem[1].length;
    const isSibling = match => match && match[1].length <= baseIndent + 1 && /\d/.test(match[2]) === ordered;
    const items = [];
    let loose = false;
    let i = start;
    while (i < lines.length) {
        const line = lines[i];
        const match = line.match(MD_LIST_ITEM);
        if (isSibling(match)) {
            items.push({ number: parseInt(match[2], 10), lines: [match[3]] });
            i++;
            continue;
        }
        if (!line.trim()) {
            // A blank line continues the list only if more list content follows.
            let j = i + 1;
            while (j < lines.length && !lines[j].trim()) j++;
            const next = lines[j];
            if (next === undefined || !(isSibling(next.match(MD_LIST_ITEM)) || markdownIndent(next) > baseIndent)) break;
            loose = true;
            items[items.length - 1].lines.push('');
            i++;
            continue;
        }
        if (markdownIndent(line) <= baseIndent) break;
        // Nested content: strip the item's indentation so sub-lists start at column 0.
        items[items.length - 1].lines.push(line.slice(Math.min(markdownIndent(line), baseIndent + 4)));
        i++;
    }

    const body = items.map(entry => {
        const inner = renderMarkdownBlocks(entry.lines);
        return `<li>${loose ? inner : inner.replace(/^<p>([\s\S]*?)<\/p>/, '$1')}</li>`;
    }).join('');
    const startAttr = ordered && items[0].number !== 1 ? ` start="${items[0].number}"` : '';
    return [ordered ? `<ol${startAttr}>${body}</ol>` : `<ul>${body}</ul>`, i];
}

function splitMarkdownRow(line) {
    let text = line.trim();
    if (text.startsWith('|')) text = text.slice(1);
    if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
    return text.split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
}

function renderInlineMarkdown(text) {
    // Pull code spans out first so their contents are never formatted.
    const slots = [];
    const hold = html => `\u0000${slots.push(html) - 1}\u0000`;
    let out = String(text).replace(/(`+)(.+?)\1(?!`)/g, (_, __, code) => hold(`<code>${escapeHtml(code.trim())}</code>`));
    out = escapeHtml(out)
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
        .replace(/\*\*(\S(?:.*?\S)?)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|\W)__(\S(?:.*?\S)?)__(?!\w)/g, '$1<strong>$2</strong>')
        .replace(/(^|[^*\w])\*([^\s*](?:[^*]*?[^\s*])?)\*(?!\*)/g, '$1<em>$2</em>')
        .replace(/(^|\W)_([^\s_](?:[^_]*?[^\s_])?)_(?!\w)/g, '$1<em>$2</em>')
        .replace(/~~(\S(?:.*?\S)?)~~/g, '<del>$1</del>');
    return out.replace(/\u0000(\d+)\u0000/g, (_, index) => slots[Number(index)]);
}

const REASONING_TAGS = ['think', 'thinking', 'reasoning'];

// Separate chain-of-thought from the final answer in raw model output.
function splitReasoning(text) {
    let answer = String(text || '');
    const reasoning = [];

    // gpt-oss "harmony" format: analysis channel is reasoning, final channel is the answer.
    if (answer.includes('<|channel|>')) {
        for (const match of answer.matchAll(/<\|channel\|>analysis<\|message\|>([\s\S]*?)(?=<\|end\|>|<\|start\|>|<\|channel\|>|$)/g)) {
            reasoning.push(match[1]);
        }
        const final = answer.match(/<\|channel\|>final<\|message\|>([\s\S]*?)(?:<\|(?:end|return)\|>|$)/);
        answer = final ? final[1] : '';
    }

    for (const tag of REASONING_TAGS) {
        const open = `<${tag}>`;
        const close = `</${tag}>`;
        // Many chat templates put the opening tag in the prompt, so the output
        // starts mid-thought and only contains the closing tag.
        const lower = answer.toLowerCase();
        const firstClose = lower.indexOf(close);
        if (firstClose !== -1 && !lower.slice(0, firstClose).includes(open)) {
            reasoning.push(answer.slice(0, firstClose));
            answer = answer.slice(firstClose + close.length);
        }
        // An unclosed tag means generation stopped while still reasoning.
        answer = answer.replace(new RegExp(`<${tag}>([\\s\\S]*?)(?:</${tag}>|$)`, 'gi'), (_, inner) => {
            reasoning.push(inner);
            return '';
        });
    }

    return {
        content: answer.trim(),
        reasoning: reasoning.map(part => part.trim()).filter(Boolean).join('\n\n'),
    };
}

function contentToText(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content.trim();
    if (typeof content === 'number' || typeof content === 'boolean') return String(content);
    if (Array.isArray(content)) {
        return content.map(part => {
            if (typeof part === 'string') return part;
            if (!part || typeof part !== 'object') return '';
            return part.text || part.content || part.value || '';
        }).join('').trim();
    }
    if (typeof content === 'object') {
        return content.text || content.content || content.value || '';
    }
    return '';
}

function responsePreview(data) {
    try {
        return JSON.stringify(data, null, 2).slice(0, 1200);
    } catch {
        return '';
    }
}

function chatServer() {
    return servers.find(s => s.config.id === chatConfigId) || servers[0] || null;
}

function chatMessages() {
    if (!chatMessagesByConfig[chatConfigId]) {
        chatMessagesByConfig[chatConfigId] = [];
    }
    return chatMessagesByConfig[chatConfigId];
}

function scrollChatToBottom() {
    const win = document.getElementById('chat-window');
    if (win) win.scrollTop = win.scrollHeight;
}

function benchmarkServer() {
    return servers.find(s => s.config.id === benchmarkConfigId) || servers[0] || null;
}

function benchmarkDefaults(profile = 'standard') {
    const config = benchmarkServer()?.config || {};
    const threads = Math.max(1, config.threads || settings?.default_threads || 4);
    const gpuLayers = config.n_gpu_layers ?? settings?.default_n_gpu_layers ?? -1;
    const base = {
        config_id: config.id || '',
        binary_path: '',
        threads: [threads],
        gpu_layers: [gpuLayers],
        batch_sizes: [2048],
        ubatch_sizes: [512],
        flash_attention: ['auto'],
        repetitions: 5,
        no_warmup: false,
        extra_args: '',
    };
    if (profile === 'quick') {
        return { ...base, prompt_tokens: [512], generation_tokens: [128], repetitions: 3 };
    }
    if (profile === 'comprehensive') {
        return {
            ...base,
            prompt_tokens: [128, 512, 2048, 4096],
            generation_tokens: [32, 64, 128, 256, 512],
            threads: [...new Set([Math.max(1, Math.floor(threads / 2)), threads])],
            gpu_layers: [...new Set([0, gpuLayers])],
            batch_sizes: [512, 2048],
        };
    }
    return { ...base, prompt_tokens: [128, 512, 2048], generation_tokens: [64, 128, 256] };
}

function renderBenchmarkPage() {
    const available = benchmarkOverview.available;
    const active = benchmarkOverview.active;
    const history = benchmarkOverview.history || [];
    const header = `
        <div class="page-header">
            <div>
                <h1>Benchmark</h1>
                <p class="subtitle">Run repeatable prompt-processing and generation matrices with llama-bench</p>
            </div>
            <div class="header-actions">
                <span class="benchmark-availability ${available ? 'available' : 'missing'}">
                    <span class="status-dot"></span>${available ? 'llama-bench detected' : 'Binary not on PATH'}
                </span>
                ${history.length ? '<button class="btn btn-ghost btn-sm" id="benchmark-clear-history">Clear History</button>' : ''}
            </div>
        </div>`;

    if (servers.length === 0) {
        return header + `
            <div class="empty-state">
                <div class="empty-state-icon">${benchmarkIcon(36)}</div>
                <h3>No Configurations</h3>
                <p>Create a model configuration first. Benchmark uses its GGUF path, thread count, GPU layers, and environment.</p>
                <a href="#configs" class="btn btn-primary">Go to Configs</a>
            </div>`;
    }

    if (active) benchmarkConfigId = active.config_id;
    if (!servers.some(s => s.config.id === benchmarkConfigId)) benchmarkConfigId = servers[0].config.id;
    const selectedServer = benchmarkServer();
    const params = active?.params || benchmarkDraft || benchmarkDefaults();
    const disabled = active ? 'disabled' : '';
    const blocked = selectedServer?.running;
    const configOptions = servers.map(s => `
        <option value="${s.config.id}" ${s.config.id === benchmarkConfigId ? 'selected' : ''}>
            ${escapeHtml(s.config.name)}${s.running ? ' (running)' : ''}
        </option>`).join('');

    const selectedRun = benchmarkSelectedRun(history);
    return header + `
        <div class="benchmark-layout">
            <form class="benchmark-panel benchmark-form-panel" id="benchmark-form" data-active-run="${escapeHtml(active?.id || '')}">
                <div class="benchmark-panel-header">
                    <div>
                        <h2>Test Matrix</h2>
                        <p>Comma-separated values create a repeatable parameter sweep.</p>
                    </div>
                    <span class="benchmark-test-count" id="benchmark-test-count">${benchmarkScenarioCount(params)} tests</span>
                </div>
                <div class="benchmark-profiles" aria-label="Benchmark profiles">
                    <button type="button" class="btn btn-ghost btn-sm benchmark-profile" data-profile="quick" ${disabled}>Quick</button>
                    <button type="button" class="btn btn-ghost btn-sm benchmark-profile" data-profile="standard" ${disabled}>Standard</button>
                    <button type="button" class="btn btn-ghost btn-sm benchmark-profile" data-profile="comprehensive" ${disabled}>Comprehensive</button>
                </div>
                <div class="form-grid benchmark-form-grid">
                    <div class="form-group full-width">
                        <label for="benchmark-config">Model Config</label>
                        <select id="benchmark-config" ${disabled}>${configOptions}</select>
                        <span class="form-hint">${escapeHtml(selectedServer?.config.model_path || '')}</span>
                    </div>
                    <div class="form-group full-width">
                        <label for="benchmark-binary">llama-bench Binary (optional)</label>
                        <input type="text" id="benchmark-binary" value="${escapeHtml(params.binary_path || '')}" placeholder="${escapeHtml(benchmarkOverview.binary_path || '/path/to/llama-bench')}" ${disabled}>
                        <span class="form-hint">Leave blank to use PATH or LLMHUB_LLAMA_BENCH.</span>
                    </div>
                    ${benchmarkListInput('benchmark-prompts', 'Prompt Tokens', params.prompt_tokens, 'Prompt-processing sizes; blank disables pp tests', disabled)}
                    ${benchmarkListInput('benchmark-generation', 'Generation Tokens', params.generation_tokens, 'Generation sizes; blank disables tg tests', disabled)}
                    ${benchmarkListInput('benchmark-threads', 'Threads', params.threads, 'CPU thread sweep', disabled)}
                    ${benchmarkListInput('benchmark-gpu-layers', 'GPU Layers', params.gpu_layers, '-1 means all; 0 means CPU', disabled)}
                    ${benchmarkListInput('benchmark-batches', 'Batch Sizes', params.batch_sizes, 'Logical batch size (-b)', disabled)}
                    ${benchmarkListInput('benchmark-ubatches', 'Micro-batch Sizes', params.ubatch_sizes, 'Physical batch size (-ub)', disabled)}
                    <div class="form-group">
                        <label for="benchmark-flash">Flash Attention</label>
                        <input type="text" id="benchmark-flash" value="${escapeHtml(params.flash_attention.join(','))}" placeholder="auto,on,off" ${disabled}>
                        <span class="form-hint">auto, on, or off</span>
                    </div>
                    <div class="form-group">
                        <label for="benchmark-repetitions">Repetitions</label>
                        <input type="number" id="benchmark-repetitions" min="1" max="20" value="${params.repetitions}" ${disabled}>
                        <span class="form-hint">Each test is averaged across these trials</span>
                    </div>
                    <div class="form-group full-width">
                        <label for="benchmark-extra-args">Extra llama-bench Arguments</label>
                        <input type="text" id="benchmark-extra-args" value="${escapeHtml(params.extra_args || '')}" placeholder="--numa isolate -ctk q8_0 -ctv q8_0" ${disabled}>
                        <span class="form-hint">Model and output-format flags are managed automatically.</span>
                    </div>
                    <div class="form-group full-width">
                        <label class="checkbox-label">
                            <input type="checkbox" id="benchmark-no-warmup" ${params.no_warmup ? 'checked' : ''} ${disabled}>
                            <span class="checkmark"></span> Skip warmup runs
                        </label>
                    </div>
                    <div class="form-group full-width">
                        <label>Command Preview</label>
                        <pre class="command-preview" id="benchmark-command-preview">${escapeHtml(benchmarkCommandPreview(params))}</pre>
                    </div>
                </div>
                ${blocked ? '<div class="benchmark-warning">Stop this config\'s server before running its benchmark.</div>' : ''}
                <div class="benchmark-actions">
                    <span>For comparable results, stop other GPU-heavy workloads first.</span>
                    <button type="submit" class="btn btn-primary" ${active || blocked ? 'disabled' : ''}>${benchmarkIcon(16)} Run Benchmark</button>
                </div>
            </form>
            <div id="benchmark-live">${active ? renderActiveBenchmark(active) : renderBenchmarkHistory(history)}</div>
        </div>
        ${active ? '' : renderBenchmarkResults(selectedRun)}`;
}

function benchmarkListInput(id, label, values, hint, disabled) {
    return `
        <div class="form-group">
            <label for="${id}">${label}</label>
            <input type="text" id="${id}" value="${escapeHtml((values || []).join(','))}" ${disabled}>
            <span class="form-hint">${hint}</span>
        </div>`;
}

function renderActiveBenchmark(run) {
    const elapsed = Math.max(0, Math.round((Date.now() - new Date(run.started_at).getTime()) / 1000));
    return `
        <section class="benchmark-panel benchmark-active-panel">
            <div class="benchmark-panel-header">
                <div><h2>Running</h2><p>${escapeHtml(run.config_name)}</p></div>
                <span class="inline-status loading"><span class="status-dot"></span>${run.status === 'stopping' ? 'Stopping' : `${elapsed}s elapsed`}</span>
            </div>
            <div class="benchmark-active-metrics">
                <div><span>Matrix</span><strong>${benchmarkScenarioCount(run.params)} tests</strong></div>
                <div><span>Repetitions</span><strong>${run.params.repetitions}</strong></div>
            </div>
            <pre class="benchmark-command">${escapeHtml(run.command_text)}</pre>
            <div class="benchmark-log">${run.log_lines?.length
                ? run.log_lines.map(line => `<div>${escapeHtml(line)}</div>`).join('')
                : '<span>llama-bench is loading the model…</span>'}</div>
            <button class="btn btn-danger" id="benchmark-stop" data-id="${run.id}" data-focus-key="benchmark-stop-${escapeHtml(run.id)}" ${run.status === 'stopping' ? 'disabled' : ''}>Stop Benchmark</button>
        </section>`;
}

function renderBenchmarkHistory(history) {
    if (!history.length) {
        return `
            <section class="benchmark-panel benchmark-history-panel">
                <div class="benchmark-panel-header"><div><h2>Recent Runs</h2><p>Completed runs are saved locally.</p></div></div>
                <div class="benchmark-history-empty">No benchmark results yet.</div>
            </section>`;
    }
    return `
        <section class="benchmark-panel benchmark-history-panel">
            <div class="benchmark-panel-header"><div><h2>Recent Runs</h2><p>Latest ${history.length} of 20 retained runs.</p></div></div>
            <div class="benchmark-history-list">
                ${history.map(run => `
                    <button type="button" class="benchmark-history-item ${benchmarkSelectedRun(history)?.id === run.id ? 'selected' : ''}" data-id="${run.id}">
                        <span><strong>${escapeHtml(run.config_name)}</strong><small>${escapeHtml(new Date(run.started_at).toLocaleString())}</small></span>
                        <span><strong class="benchmark-run-status ${run.status}">${escapeHtml(run.status)}</strong><small>${run.results.length} tests · ${run.duration_seconds ?? 0}s</small></span>
                    </button>`).join('')}
            </div>
        </section>`;
}

function renderBenchmarkResults(run) {
    if (!run) return '';
    if (run.status !== 'completed') {
        return `
            <section class="benchmark-results-panel">
                <div class="benchmark-panel-header"><div><h2>Run Details</h2><p>${escapeHtml(run.config_name)}</p></div></div>
                <div class="benchmark-warning error">${escapeHtml(run.error || `Benchmark ${run.status}`)}</div>
                ${run.log_lines?.length ? `<pre class="benchmark-failure-log">${escapeHtml(run.log_lines.join('\n'))}</pre>` : ''}
            </section>`;
    }
    const promptResults = run.results.filter(item => Number(item.n_prompt) > 0);
    const generationResults = run.results.filter(item => Number(item.n_gen) > 0);
    const bestPrompt = bestBenchmarkResult(promptResults);
    const bestGeneration = bestBenchmarkResult(generationResults);
    const first = run.results[0] || {};
    return `
        <section class="benchmark-results-panel">
            <div class="benchmark-panel-header">
                <div><h2>Results · ${escapeHtml(run.config_name)}</h2><p>${escapeHtml(first.model_type || run.model_path)}</p></div>
                <button class="btn btn-ghost btn-sm" id="benchmark-export-run" data-id="${run.id}">${downloadIcon(14)} Export JSON</button>
            </div>
            <div class="benchmark-summary-grid">
                ${benchmarkSummaryCard('Best Prompt', bestPrompt ? `${formatBenchmarkRate(bestPrompt.avg_ts)} t/s` : 'n/a', bestPrompt ? benchmarkTestLabel(bestPrompt) : '')}
                ${benchmarkSummaryCard('Best Generation', bestGeneration ? `${formatBenchmarkRate(bestGeneration.avg_ts)} t/s` : 'n/a', bestGeneration ? benchmarkTestLabel(bestGeneration) : '')}
                ${benchmarkSummaryCard('Backend', first.backends || 'Unknown', first.gpu_info || first.cpu_info || '')}
                ${benchmarkSummaryCard('Run', `${run.results.length} tests`, `${run.duration_seconds ?? 0}s · ${run.params.repetitions} reps`)}
            </div>
            <div class="benchmark-table-wrap">
                <table class="benchmark-table">
                    <thead><tr><th>Test</th><th>Threads</th><th>GPU Layers</th><th>Batch</th><th>Micro-batch</th><th>Flash</th><th>Throughput</th><th>Stddev</th></tr></thead>
                    <tbody>${run.results.map(item => `
                        <tr>
                            <td><strong>${escapeHtml(benchmarkTestLabel(item))}</strong></td>
                            <td>${item.n_threads ?? '—'}</td>
                            <td>${item.n_gpu_layers === -1 ? 'all' : item.n_gpu_layers ?? '—'}</td>
                            <td>${item.n_batch ?? '—'}</td>
                            <td>${item.n_ubatch ?? '—'}</td>
                            <td>${escapeHtml(benchmarkFlashLabel(item.flash_attn))}</td>
                            <td class="benchmark-rate">${formatBenchmarkRate(item.avg_ts)} t/s</td>
                            <td>± ${formatBenchmarkRate(item.stddev_ts)}</td>
                        </tr>`).join('')}</tbody>
                </table>
            </div>
        </section>`;
}

function benchmarkSummaryCard(label, value, detail) {
    return `<div class="benchmark-summary-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></div>`;
}

function bindBenchmarkEvents() {
    document.getElementById('benchmark-config')?.addEventListener('change', e => {
        rememberConfig(e.target.value);
        benchmarkDraft = null;
        refreshBenchmarkSurface({preserve: false});
    });
    document.querySelectorAll('.benchmark-profile').forEach(button => {
        button.addEventListener('click', () => {
            benchmarkDraft = benchmarkDefaults(button.dataset.profile);
            refreshBenchmarkSurface({preserve: false});
        });
    });
    document.getElementById('benchmark-form')?.addEventListener('submit', startLlamaBenchmark);
    document.querySelectorAll('#benchmark-form input').forEach(input => {
        input.addEventListener('input', updateBenchmarkPreview);
        input.addEventListener('change', updateBenchmarkPreview);
    });
    document.getElementById('benchmark-stop')?.addEventListener('click', stopLlamaBenchmark);
    document.querySelectorAll('.benchmark-history-item').forEach(button => {
        button.addEventListener('click', () => {
            benchmarkSelectedRunId = button.dataset.id;
            refreshBenchmarkSurface();
        });
    });
    document.getElementById('benchmark-export-run')?.addEventListener('click', () => {
        const run = (benchmarkOverview.history || []).find(item => item.id === benchmarkSelectedRunId) || benchmarkOverview.history?.[0];
        if (run) downloadJson(run, `llmhub-benchmark-${run.id}.json`);
    });
    document.getElementById('benchmark-clear-history')?.addEventListener('click', () => {
        showConfirm('Clear benchmark history?', 'All completed benchmark results will be removed.', async () => {
            try {
                await apiDelete('/benchmarks');
                benchmarkOverview.history = [];
                benchmarkSelectedRunId = '';
                refreshBenchmarkSurface();
                showToast('Benchmark history cleared', 'info');
            } catch (e) {
                showToast('Could not clear history: ' + e.message, 'error');
            }
        });
    });
}

async function startLlamaBenchmark(event) {
    event.preventDefault();
    try {
        const payload = benchmarkPayloadFromForm();
        benchmarkDraft = payload;
        const run = await apiPost('/benchmarks', payload);
        benchmarkOverview.active = run;
        showToast('Benchmark started', 'success');
        refreshBenchmarkSurface();
        startBenchmarkPoller();
    } catch (e) {
        showToast('Benchmark could not start: ' + e.message, 'error');
    }
}

async function stopLlamaBenchmark(event) {
    const button = event.currentTarget;
    button.disabled = true;
    try {
        await apiPost(`/benchmarks/${button.dataset.id}/stop`);
        await fetchBenchmarks({ quiet: true });
        refreshBenchmarkSurface();
        showToast('Benchmark stop requested', 'info');
    } catch (e) {
        button.disabled = false;
        showToast('Could not stop benchmark: ' + e.message, 'error');
    }
}

function benchmarkPayloadFromForm() {
    const flash = document.getElementById('benchmark-flash').value.split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
    if (!flash.length || flash.some(value => !['auto', 'on', 'off'].includes(value))) {
        throw new Error('Flash attention values must be auto, on, or off');
    }
    return {
        config_id: benchmarkConfigId,
        binary_path: document.getElementById('benchmark-binary').value.trim(),
        prompt_tokens: parseBenchmarkIntegerList('benchmark-prompts', { allowEmpty: true, min: 1 }),
        generation_tokens: parseBenchmarkIntegerList('benchmark-generation', { allowEmpty: true, min: 1 }),
        threads: parseBenchmarkIntegerList('benchmark-threads', { min: 1 }),
        gpu_layers: parseBenchmarkIntegerList('benchmark-gpu-layers', { min: -1 }),
        batch_sizes: parseBenchmarkIntegerList('benchmark-batches', { min: 1 }),
        ubatch_sizes: parseBenchmarkIntegerList('benchmark-ubatches', { min: 1 }),
        flash_attention: [...new Set(flash)],
        repetitions: parseInt(document.getElementById('benchmark-repetitions').value, 10),
        no_warmup: document.getElementById('benchmark-no-warmup').checked,
        extra_args: document.getElementById('benchmark-extra-args').value.trim(),
    };
}

function parseBenchmarkIntegerList(id, { allowEmpty = false, min = 1 } = {}) {
    const raw = document.getElementById(id).value.trim();
    if (!raw && allowEmpty) return [];
    const values = raw.split(',').map(value => Number(value.trim()));
    if (!values.length || values.some(value => !Number.isInteger(value) || value < min)) {
        throw new Error(`${document.querySelector(`label[for="${id}"]`)?.textContent || id} must be comma-separated integers of ${min} or greater`);
    }
    return [...new Set(values)];
}

function updateBenchmarkPreview() {
    capturePageState();
    try {
        const params = benchmarkPayloadFromForm();
        document.getElementById('benchmark-test-count').textContent = `${benchmarkScenarioCount(params)} tests`;
        document.getElementById('benchmark-command-preview').textContent = benchmarkCommandPreview(params);
    } catch {
        document.getElementById('benchmark-test-count').textContent = 'Check values';
    }
}

function benchmarkCommandPreview(params) {
    const config = benchmarkServer()?.config || {};
    const binary = params.binary_path || benchmarkOverview.binary_path || 'llama-bench';
    return [
        shellQuote(binary), '-m', shellQuote(config.model_path || '/path/to/model.gguf'),
        '-p', (params.prompt_tokens || []).join(',') || '0',
        '-n', (params.generation_tokens || []).join(',') || '0',
        '-t', (params.threads || []).join(','),
        '-ngl', (params.gpu_layers || []).join(','),
        '-b', (params.batch_sizes || []).join(','),
        '-ub', (params.ubatch_sizes || []).join(','),
        '-fa', (params.flash_attention || []).join(','),
        '-r', params.repetitions,
        params.no_warmup ? '--no-warmup' : '',
        params.extra_args || '', '--progress -o json',
    ].filter(value => value !== '').join(' ');
}

function benchmarkScenarioCount(params) {
    const base = (params.prompt_tokens?.length || 0) + (params.generation_tokens?.length || 0);
    return base
        * (params.threads?.length || 0)
        * (params.gpu_layers?.length || 0)
        * (params.batch_sizes?.length || 0)
        * (params.ubatch_sizes?.length || 0)
        * (params.flash_attention?.length || 0);
}

function benchmarkSelectedRun(history) {
    const selected = history.find(run => run.id === benchmarkSelectedRunId) || history[0] || null;
    if (selected) benchmarkSelectedRunId = selected.id;
    return selected;
}

function refreshBenchmarkSurface({preserve = true} = {}) {
    if (currentPage !== 'benchmark') return;
    const active = benchmarkOverview.active;
    if (active && document.getElementById('benchmark-form')?.dataset.activeRun === active.id) {
        replaceSurface('benchmark-live', renderActiveBenchmark(active));
        document.getElementById('benchmark-stop').onclick = stopLlamaBenchmark;
        return;
    }
    if (preserve) capturePageState();
    else pageStates.delete('benchmark');
    document.getElementById('main-content').innerHTML = renderBenchmarkPage();
    if (preserve) restorePageState('benchmark');
    bindBenchmarkEvents();
}

function bestBenchmarkResult(results) {
    return results.reduce((best, item) => Number(item.avg_ts) > Number(best?.avg_ts ?? -1) ? item : best, null);
}

function benchmarkTestLabel(item) {
    const prompt = Number(item.n_prompt) || 0;
    const generation = Number(item.n_gen) || 0;
    if (prompt && generation) return `pp${prompt} + tg${generation}`;
    if (prompt) return `pp${prompt}`;
    if (generation) return `tg${generation}`;
    return 'custom';
}

function benchmarkFlashLabel(value) {
    return ({ '-1': 'auto', 0: 'off', 1: 'on', auto: 'auto', off: 'off', on: 'on' })[value] ?? String(value ?? '—');
}

function formatBenchmarkRate(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    return number.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderTokenCalculatorPage() {
    const header = `
        <div class="page-header">
            <div>
                <h1>Token Calculator</h1>
                <p class="subtitle">Estimate spend from tracked input and output token usage</p>
            </div>
        </div>`;

    if (servers.length === 0) {
        return header + `
            <div class="empty-state">
                <div class="empty-state-icon">${calculatorIcon(36)}</div>
                <h3>No Configurations</h3>
                <p>Create a server configuration first to calculate token spend.</p>
                <a href="#configs" class="btn btn-primary">Go to Configs</a>
            </div>`;
    }

    if (!servers.some(s => s.config.id === tokenCalculatorConfigId)) {
        tokenCalculatorConfigId = servers[0].config.id;
    }

    const options = servers.map(s => `<option value="${s.config.id}" ${s.config.id === tokenCalculatorConfigId ? 'selected' : ''}>${escapeHtml(s.config.name)}</option>`).join('');
    const selected = tokenCalculatorServer();
    const usage = tokenUsage(selected);
    const costs = tokenCalculatorCosts();

    return header + `
        <section class="calculator-panel">
            <div class="calculator-controls">
                <div class="form-group full-width">
                    <label for="token-calculator-server">Server Config</label>
                    <select id="token-calculator-server">${options}</select>
                </div>
                <div class="form-group">
                    <label for="token-input-price">Input Tokens Price</label>
                    <input type="number" id="token-input-price" min="0" step="0.000001" placeholder="0.00" value="${escapeHtml(tokenCalculatorInputPrice)}">
                </div>
                <div class="form-group">
                    <label for="token-output-price">Output Tokens Price</label>
                    <input type="number" id="token-output-price" min="0" step="0.000001" placeholder="0.00" value="${escapeHtml(tokenCalculatorOutputPrice)}">
                </div>
                <div class="form-group">
                    <label for="token-price-magnitude">Pricing Unit</label>
                    <select id="token-price-magnitude">
                        ${option('1', 'Per token', tokenCalculatorMagnitude)}
                        ${option('1000', 'Per 1K tokens (/K)', tokenCalculatorMagnitude)}
                        ${option('1000000', 'Per 1M tokens (/M)', tokenCalculatorMagnitude)}
                        ${option('1000000000', 'Per 1B tokens (/B)', tokenCalculatorMagnitude)}
                    </select>
                </div>
            </div>
            <div class="calculator-summary" id="token-calculator-summary">
                ${renderTokenCalculatorSummary(usage, costs)}
            </div>
        </section>`;
}

function bindTokenCalculatorEvents() {
    document.getElementById('token-calculator-server')?.addEventListener('change', e => {
        rememberConfig(e.target.value);
        updateTokenCalculatorSummary();
    });
    document.getElementById('token-input-price')?.addEventListener('input', e => {
        tokenCalculatorInputPrice = e.target.value;
        updateTokenCalculatorSummary();
    });
    document.getElementById('token-output-price')?.addEventListener('input', e => {
        tokenCalculatorOutputPrice = e.target.value;
        updateTokenCalculatorSummary();
    });
    document.getElementById('token-price-magnitude')?.addEventListener('change', e => {
        tokenCalculatorMagnitude = e.target.value;
        updateTokenCalculatorSummary();
    });
}

function updateTokenCalculatorSummary() {
    const panel = document.getElementById('token-calculator-summary');
    if (!panel) return;
    panel.innerHTML = renderTokenCalculatorSummary(tokenUsage(tokenCalculatorServer()), tokenCalculatorCosts());
}

function renderTokenCalculatorSummary(usage, costs) {
    return `
        <div class="calculator-total">
            <span class="calculator-total-label">Estimated Spend</span>
            <strong>${formatCurrency(costs.totalCost)}</strong>
        </div>
        <div class="calculator-breakdown">
            <div>
                <span class="label">Input Tokens</span>
                <span class="value">${formatTokens(usage.prompt_tokens)}</span>
                <span class="cost">${formatCurrency(costs.inputCost)}</span>
            </div>
            <div>
                <span class="label">Output Tokens</span>
                <span class="value">${formatTokens(usage.completion_tokens)}</span>
                <span class="cost">${formatCurrency(costs.outputCost)}</span>
            </div>
            <div>
                <span class="label">Total Tokens</span>
                <span class="value">${formatTokens(usage.total_tokens)}</span>
                <span class="cost">${usage.request_count.toLocaleString()} requests</span>
            </div>
        </div>`;
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
    rememberConfig(serverId);
    terminalLines = [];
    renderTerminalLines();
    stopTerminalPoller();
    pollTerminalOutput();
}

function stopTerminalPoller() {
    terminalRequestId += 1;
    if (terminalPoller) {
        clearTimeout(terminalPoller);
        terminalPoller = null;
    }
}

async function pollTerminalOutput() {
    if (currentPage !== 'terminal' || !currentTerminalServerId) return;
    const serverId = currentTerminalServerId;
    const requestId = ++terminalRequestId;

    try {
        if (terminalPaused) return;
        // Refresh the bounded snapshot so partial lines, rollover, clears, and
        // process restarts are reflected without duplicating or missing output.
        const data = await apiGet(`/configs/${serverId}/output?offset=0`);
        if (requestId !== terminalRequestId || currentPage !== 'terminal' || terminalPaused) return;
        const server = servers.find(s => s.config.id === serverId);
        updateTerminalStatus(data.running, data.running ? server?.health : 'stopped');
        terminalLines = data.lines || [];
        renderTerminalLines();
        renderLogAnnotations(data.annotations || []);
    } catch (e) {
        console.error('Terminal polling failed:', e);
    } finally {
        if (requestId === terminalRequestId && currentPage === 'terminal') {
            terminalPoller = setTimeout(pollTerminalOutput, 1000);
        }
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
    document.getElementById('terminal-autoscroll-btn').setAttribute('aria-pressed', String(terminalAutoScroll));
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
    const serverId = currentTerminalServerId;
    stopTerminalPoller();
    const requestId = terminalRequestId;
    try {
        await apiPost(`/configs/${serverId}/output/clear`);
        if (requestId !== terminalRequestId || currentPage !== 'terminal') return;
        terminalLines = [];
        renderTerminalLines();
        showToast('Terminal output cleared', 'info');
    } catch (e) {
        showToast('Failed to clear output: ' + e.message, 'error');
    } finally {
        if (requestId === terminalRequestId && currentPage === 'terminal') pollTerminalOutput();
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
    document.getElementById('config-output-unlimited').checked = (config?.n_predict ?? -1) === -1;
    document.getElementById('config-output-tokens').value = config?.n_predict >= 0 ? config.n_predict : 512;
    syncOutputLimit();
    clearConfigErrors();
    document.getElementById('config-advanced-section').open = false;
    document.getElementById('config-threads').value = config?.threads || defaults.default_threads || 4;
    document.getElementById('config-parallel').value = config?.parallel || defaults.default_parallel || 1;
    document.getElementById('config-cont-batching').checked = config?.cont_batching ?? true;
    document.getElementById('config-mmproj-path').value = config?.mmproj_path || '';
    document.getElementById('config-extra-args').value = config?.extra_args || '';
    document.getElementById('config-advanced-args').value = (config?.advanced_args || []).join('\n');
    document.getElementById('config-env-vars').value = Object.entries(config?.env_vars || {}).map(([key, value]) => `${key}=${value}`).join('\n');
    setupModelPathPicker();
    updateCommandPreview();
    const overlay = document.getElementById('config-modal');
    overlay.classList.add('open');
    activateDialog(overlay, closeModal);
}

function populatePresetSelect() {
    const select = document.getElementById('config-preset');
    if (!select) return;
    select.innerHTML = `<option value="custom">Custom</option>${presets.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}`;
}

function closeModal() {
    const overlay = document.getElementById('config-modal');
    overlay.classList.remove('open');
    deactivateDialog(overlay);
    overlay.inert = true;
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
        input.setAttribute('aria-expanded', 'true');
        input.removeAttribute('aria-activedescendant');
        return;
    }

    menu.innerHTML = matches.map((item, index) => `
        <div class="model-path-option ${index === modelPathActiveIndex ? 'active' : ''}" role="option" id="model-path-option-${index}" aria-selected="${index === modelPathActiveIndex}" data-path="${escapeHtml(item.path)}">
            <div class="model-path-option-name">${escapeHtml(item.name)}</div>
            <div class="model-path-option-meta">${escapeHtml(item.size_label ? `${item.size_label} - ${item.path}` : item.path)}</div>
        </div>
    `).join('');
    menu.classList.add('open');
    input.setAttribute('aria-expanded', 'true');
    setModelPathActive(modelPathActiveIndex);

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
        if (menu?.classList.contains('open')) { e.stopPropagation(); e.preventDefault(); }
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
    document.getElementById('config-model-path').setAttribute('aria-activedescendant', `model-path-option-${index}`);
    modelPathActiveIndex = index;
    document.querySelectorAll('#model-path-menu .model-path-option').forEach((el, optionIndex) => {
        el.classList.toggle('active', optionIndex === index);
        el.setAttribute('aria-selected', String(optionIndex === index));
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
    document.getElementById('config-model-path').setAttribute('aria-expanded', 'false');
    document.getElementById('config-model-path').removeAttribute('aria-activedescendant');
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

document.getElementById('config-output-unlimited').addEventListener('change', () => { syncOutputLimit(); updateCommandPreview(); });
document.getElementById('config-form').addEventListener('input', event => {
    clearConfigFieldError(event.target);
    document.getElementById('config-form-error').hidden = true;
});
document.getElementById('config-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!validateConfigForm()) return;
    const id = document.getElementById('config-id').value;
    const button = document.getElementById('modal-save');
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
        const data = formConfigData();
        if (id) await apiPut(`/configs/${id}`, data);
        else await apiPost('/configs', data);
        closeModal();
        showToast(id ? 'Configuration updated' : 'Configuration created', 'success');
        await render();
    } catch (error) {
        const fields = {name: 'name', model_path: 'model-path', host: 'host', port: 'port', n_gpu_layers: 'gpu-layers', ctx_size: 'ctx-size', n_predict: 'output-tokens', threads: 'threads', parallel: 'parallel', mmproj_path: 'mmproj-path', extra_args: 'extra-args', advanced_args: 'advanced-args', env_vars: 'env-vars'};
        (error.fields || []).forEach(field => {
            const name = field.loc.find(part => Object.hasOwn(fields, part));
            if (name) setConfigFieldError(document.getElementById(`config-${fields[name]}`), field.msg.replace(/^Value error, /, ''));
        });
        const summary = document.getElementById('config-form-error');
        summary.textContent = error.fields?.length ? 'Check the highlighted fields and try again.' : error.message;
        summary.hidden = false;
        focusConfigError();
    } finally {
        button.disabled = false;
        button.textContent = 'Save configuration';
    }
});

function syncOutputLimit() {
    const input = document.getElementById('config-output-tokens');
    input.disabled = document.getElementById('config-output-unlimited').checked;
    clearConfigFieldError(input);
}

function clearConfigFieldError(input) {
    input?.removeAttribute('aria-invalid');
    const errorId = `${input?.id}-error`;
    document.getElementById(errorId)?.remove();
    if (input) {
        const descriptions = (input.getAttribute('aria-describedby') || '').split(' ').filter(id => id && id !== errorId);
        if (descriptions.length) input.setAttribute('aria-describedby', descriptions.join(' '));
        else input.removeAttribute('aria-describedby');
    }
}

function clearConfigErrors() {
    document.querySelectorAll('#config-form [aria-invalid]').forEach(clearConfigFieldError);
    document.getElementById('config-form-error').hidden = true;
}

function setConfigFieldError(input, message) {
    if (!input) return;
    clearConfigFieldError(input);
    input.setAttribute('aria-invalid', 'true');
    const error = document.createElement('span');
    error.id = `${input.id}-error`;
    error.className = 'field-error';
    error.textContent = message;
    input.closest('.form-group').appendChild(error);
    input.setAttribute('aria-describedby', `${input.getAttribute('aria-describedby') || ''} ${error.id}`.trim());
}

function focusConfigError() {
    const first = document.querySelector('#config-form [aria-invalid="true"]');
    if (first) {
        const advanced = first.closest('details');
        if (advanced) advanced.open = true;
        first.focus();
    }
}

function validateConfigForm() {
    clearConfigErrors();
    document.querySelectorAll('#config-form input:not([type="hidden"]), #config-form textarea').forEach(input => {
        if (input.disabled || input.type === 'checkbox') return;
        let message = '';
        if (input.required && !input.value.trim()) message = 'This field is required.';
        else if (!input.validity.valid) message = input.validationMessage;
        else if (input.id === 'config-model-path' && !/\.gguf$/i.test(input.value.trim())) message = 'Choose a .gguf model file.';
        else if (input.id === 'config-mmproj-path' && input.value.trim() && !/\.(gguf|mmproj)$/i.test(input.value.trim())) message = 'Choose a .gguf or .mmproj projector.';
        else if (input.id === 'config-env-vars' && linesFromText(input.value).some(line => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(line))) message = 'Use one KEY=value entry per line.';
        if (message) setConfigFieldError(input, message);
    });
    const valid = !document.querySelector('#config-form [aria-invalid="true"]');
    if (!valid) focusConfigError();
    return valid;
}

function formConfigData() {
    return {
        name: document.getElementById('config-name').value,
        model_path: document.getElementById('config-model-path').value,
        host: document.getElementById('config-host').value,
        port: parseInt(document.getElementById('config-port').value, 10),
        n_gpu_layers: parseInt(document.getElementById('config-gpu-layers').value, 10),
        ctx_size: parseInt(document.getElementById('config-ctx-size').value, 10),
        n_predict: document.getElementById('config-output-unlimited').checked ? -1 : Number(document.getElementById('config-output-tokens').value),
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
        data.n_predict >= 0 ? `--n-predict ${data.n_predict}` : '',
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

function dialogFocusables(overlay) {
    return [...overlay.querySelectorAll('button, a[href], input, select, textarea, summary, [tabindex]')].filter(el => {
        const collapsed = el.closest('details:not([open])');
        return !el.disabled && el.tabIndex >= 0 && el.getClientRects().length && !el.closest('[inert]')
            && (!collapsed || collapsed.querySelector('summary') === el);
    });
}

function activateDialog(overlay, close) {
    if (dialogStack.some(item => item.overlay === overlay)) return;
    const panel = overlay.querySelector('.modal, .confirm-dialog');
    const trigger = document.activeElement;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.tabIndex = -1;
    const title = panel.querySelector('h2, h3');
    if (title) {
        title.id ||= `dialog-title-${Date.now()}-${dialogStack.length}`;
        panel.setAttribute('aria-labelledby', title.id);
    }
    const previous = dialogStack.at(-1);
    if (previous) previous.overlay.inert = true;
    overlay.inert = false;
    dialogStack.push({overlay, close, trigger});
    panel.focus({preventScroll: true});
    document.querySelectorAll('.workspace-shell, .sidebar, .skip-link').forEach(el => { el.inert = true; });
    document.body.classList.add('dialog-open');
    requestAnimationFrame(() => {
        if (dialogStack.at(-1)?.overlay === overlay && (document.activeElement === panel || !overlay.contains(document.activeElement))) {
            (dialogFocusables(overlay).find(el => el.tagName === 'INPUT') || dialogFocusables(overlay)[0] || panel).focus();
        }
    });
}

function deactivateDialog(overlay) {
    const index = dialogStack.findIndex(item => item.overlay === overlay);
    if (index < 0) return;
    const [dialog] = dialogStack.splice(index, 1);
    const previous = dialogStack.at(-1);
    if (previous) previous.overlay.inert = false;
    else {
        document.querySelectorAll('.workspace-shell, .sidebar, .skip-link').forEach(el => { el.inert = false; });
        document.body.classList.remove('dialog-open');
    }
    const restoredTrigger = dialog.trigger?.isConnected ? dialog.trigger : (dialog.trigger?.id ? document.getElementById(dialog.trigger.id) : [...document.querySelectorAll('[data-focus-key]')].find(el => el.dataset.focusKey === dialog.trigger?.dataset.focusKey));
    if (restoredTrigger) restoredTrigger.focus({preventScroll: true});
    else if (!previous) document.getElementById('main-content').focus({preventScroll: true});
}

function dismissDialog(overlay) {
    deactivateDialog(overlay);
    overlay.remove();
}

document.addEventListener('keydown', event => {
    const active = dialogStack.at(-1);
    if (event.key === 'Escape') {
        const picker = document.getElementById('model-path-menu');
        if (picker?.classList.contains('open')) { hideModelPathMenu(); event.preventDefault(); return; }
        if (active) { event.preventDefault(); active.close(); return; }
        document.querySelectorAll('.action-menu[open]').forEach(menu => { menu.open = false; menu.querySelector('summary').focus(); });
    }
    if (event.key !== 'Tab' || !active) return;
    const items = dialogFocusables(active.overlay);
    const first = items[0];
    const last = items.at(-1);
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && (document.activeElement === first || !items.includes(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !items.includes(document.activeElement))) { event.preventDefault(); first.focus(); }
});
document.addEventListener('click', event => {
    document.querySelectorAll('.action-menu[open]').forEach(menu => { if (!menu.contains(event.target)) menu.open = false; });
});

function positionActionMenu(menu) {
    const items = menu.querySelector('.action-menu-items');
    if (!items) return;
    const rect = menu.querySelector('summary').getBoundingClientRect();
    items.style.left = `${Math.max(12, Math.min(rect.right - 205, window.innerWidth - 217))}px`;
    items.style.top = `${Math.max(12, Math.min(rect.bottom + 7, window.innerHeight - items.offsetHeight - 12))}px`;
}

document.addEventListener('toggle', event => {
    if (event.target.matches('.action-menu[open]')) positionActionMenu(event.target);
}, true);
window.addEventListener('scroll', () => {
    document.querySelectorAll('.action-menu[open]').forEach(positionActionMenu);
}, true);

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
    activateDialog(overlay, () => dismissDialog(overlay));
    overlay.querySelector('.confirm-cancel').addEventListener('click', () => dismissDialog(overlay));
    overlay.querySelector('.confirm-ok').addEventListener('click', async () => {
        dismissDialog(overlay);
        await onConfirm();
    });
    overlay.addEventListener('click', e => {
        if (e.target === overlay) dismissDialog(overlay);
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
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function formatOutputLimit(value) {
    return value == null || value === -1 ? 'Unlimited' : `${value.toLocaleString()} tokens`;
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

function tokenUsage(server) {
    return server?.token_usage || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        request_count: 0,
        last_used_at: null,
    };
}

function formatTokens(value) {
    const tokens = numberOrNull(value) || 0;
    return tokens.toLocaleString();
}

function tokenCalculatorServer() {
    return servers.find(s => s.config.id === tokenCalculatorConfigId) || servers[0] || null;
}

function tokenCalculatorCosts() {
    const usage = tokenUsage(tokenCalculatorServer());
    const magnitude = Math.max(1, numberOrNull(tokenCalculatorMagnitude) || 1000000);
    const inputPrice = numberOrNull(tokenCalculatorInputPrice) || 0;
    const outputPrice = numberOrNull(tokenCalculatorOutputPrice) || 0;
    const inputCost = (usage.prompt_tokens / magnitude) * inputPrice;
    const outputCost = (usage.completion_tokens / magnitude) * outputPrice;
    return {
        inputCost,
        outputCost,
        totalCost: inputCost + outputCost,
    };
}

function formatCurrency(value) {
    const amount = numberOrNull(value) || 0;
    return amount.toLocaleString(undefined, {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: amount > 0 && amount < 0.01 ? 6 : 2,
        maximumFractionDigits: amount > 0 && amount < 0.01 ? 6 : 2,
    });
}

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
}

function shellQuote(value) {
    const text = String(value ?? '');
    return /^[A-Za-z0-9_./:=+-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}

function serverUrl(config) {
    return `http://${config.host}:${config.port}`;
}

function trackedChatUrl(config) {
    return `${window.location.origin}${API_BASE}/configs/${config.id}/v1/chat/completions`;
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

function uiIcon(size, paths) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}
function searchIcon(size) { return uiIcon(size, '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>'); }
function gridIcon(size) { return uiIcon(size, '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'); }
function listIcon(size) { return uiIcon(size, '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'); }
function moreIcon(size) { return uiIcon(size, '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'); }
function chipIcon(size) { return uiIcon(size, '<rect x="5" y="5" width="14" height="14" rx="3"/><path d="M9 1v4m6-4v4M9 19v4m6-4v4M1 9h4m-4 6h4m14-6h4m-4 6h4"/><rect x="9" y="9" width="6" height="6" rx="1"/>'); }
function checkIcon(size) { return uiIcon(size, '<path d="m5 12 4 4L19 6"/>'); }
function eyeIcon(size) { return uiIcon(size, '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'); }

function serverIcon(size) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/></svg>`;
}

function gearIcon(size) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
}

function terminalIcon(size) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`;
}

function chatIcon(size) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="13" y2="13"/></svg>`;
}

function calculatorIcon(size) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="3" width="16" height="18" rx="2"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="10" y2="12"/><line x1="14" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="10" y2="16"/><line x1="14" y1="16" x2="16" y2="16"/></svg>`;
}

function benchmarkIcon(size) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 18l4-5"/><path d="M7 18h10"/></svg>`;
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
