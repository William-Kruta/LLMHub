const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadApp() {
    const elements = new Map();
    const timers = new Map();
    let timerId = 0;
    const context = vm.createContext({
        console,
        window: {addEventListener() {}, scrollTo() {}, scrollY: 0},
        requestAnimationFrame() {},
        document: {
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, {
                    value: '', textContent: '', innerHTML: '', checked: false,
                    addEventListener() {},
                    classList: { add() {}, remove() {}, toggle() {} },
                    removeAttribute() {}, setAttribute() {}, getAttribute: () => '',
                    remove() {},
                });
                return elements.get(id);
            },
            querySelectorAll: () => [],
            querySelector: () => null,
            addEventListener() {},
        },
        setTimeout(callback) {
            timers.set(++timerId, callback);
            return timerId;
        },
        clearTimeout: id => timers.delete(id),
    });
    // Exercise the full app with controlled DOM/network boundaries, without
    // starting the router's initial network requests.
    const source = fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf8');
    vm.runInContext(source.replace(/\ninitRouter\(\);\s*$/, '\n'), context);
    const run = source => vm.runInContext(source, context);
    run(`
        renderTerminalLines = () => {};
        renderLogAnnotations = () => {};
        updateTerminalStatus = () => {};
        activateDialog = () => {};
        currentPage = 'terminal';
        currentTerminalServerId = 'first';
    `);
    return {
        context, run, elements, timers,
        lines: () => JSON.parse(run('JSON.stringify(terminalLines)')),
        async tick() {
            assert.equal(timers.size, 1, 'only one terminal poll should be scheduled');
            const [id, callback] = timers.entries().next().value;
            timers.delete(id);
            await callback();
        },
    };
}

for (const limit of [-1, 0, 2048]) {
    test(`config form preserves an output token limit of ${limit}`, () => {
        const app = loadApp();
        app.run(`openModal({id: 'model', name: 'Model', model_path: '/tmp/model.gguf', n_predict: ${limit}})`);
        assert.equal(app.run('formConfigData().n_predict'), limit);
        const preview = app.elements.get('command-preview').textContent;
        if (limit === -1) assert.doesNotMatch(preview, /--n-predict/);
        else assert.match(preview, new RegExp(`--n-predict ${limit}$`));
    });
}

test('terminal updates partial lines and survives rollover, clears, and restarts', async () => {
    const app = loadApp();
    const snapshots = [
        {lines: ['loading'], total: 1},
        {lines: ['loading model', 'ready'], total: 2},
        {lines: ['latest retained line'], total: 2001},
        {lines: [], total: 2001},
        {lines: ['restarted'], total: 1},
    ];
    let index = 0;
    app.context.apiGet = async () => ({...snapshots[index++], running: true});

    await app.context.pollTerminalOutput();
    assert.deepEqual(app.lines(), snapshots[0].lines);
    for (const snapshot of snapshots.slice(1)) {
        await app.tick();
        assert.deepEqual(app.lines(), snapshot.lines);
    }
});

test('switching terminal servers ignores a delayed response from the old server', async () => {
    const app = loadApp();
    let resolveOld;
    app.context.apiGet = url => url.includes('/first/')
        ? new Promise(resolve => { resolveOld = resolve; })
        : Promise.resolve({lines: ['second server'], total: 1, running: true});

    const oldPoll = app.context.pollTerminalOutput();
    app.run("switchTerminalServer('second')");
    await new Promise(setImmediate);
    assert.deepEqual(app.lines(), ['second server']);
    resolveOld({lines: ['old server'], total: 1, running: true});
    await oldPoll;
    assert.deepEqual(app.lines(), ['second server']);
    assert.equal(app.timers.size, 1);
});

test('server fetch failures retain cached data and successful retries clear the error', async () => {
    const app = loadApp();
    app.run('updateConnectionNotice = () => {}');
    const cached = [{config: {id: 'cached'}, running: false}];
    app.context.apiGet = async () => cached;
    await app.context.fetchServers();
    app.context.apiGet = async () => { throw new Error('Offline'); };
    await app.context.fetchServers();
    assert.equal(app.run('servers[0].config.id'), 'cached');
    assert.equal(app.run('connectionErrors.has("servers")'), true);
    app.context.apiGet = async () => cached;
    await app.context.fetchServers();
    assert.equal(app.run('connectionErrors.has("servers")'), false);
});

test('an older fetch cannot overwrite newer server data', async () => {
    const app = loadApp();
    app.run('updateConnectionNotice = () => {}');
    let resolveOld;
    app.context.apiGet = () => new Promise(resolve => { resolveOld = resolve; });
    const older = app.context.fetchServers();
    app.context.apiGet = async () => [{config: {id: 'new'}, running: true}];
    await app.context.fetchServers();
    resolveOld([{config: {id: 'old'}, running: false}]);
    await older;
    assert.equal(app.run('servers[0].config.id'), 'new');
});

test('a pending hub poll cannot repaint a different page', async () => {
    const app = loadApp();
    app.run("currentPage = 'hub'");
    let resolveFetch;
    let refreshes = 0;
    app.context.fetchServers = () => new Promise(resolve => { resolveFetch = resolve; });
    app.context.fetchGpus = async () => {};
    app.context.fetchRam = async () => {};
    app.context.refreshHubSurface = () => { refreshes += 1; };
    app.context.startHubPoller();
    const pending = app.tick();
    app.context.stopHubPoller();
    app.run("currentPage = 'configs'");
    resolveFetch();
    await pending;
    assert.equal(refreshes, 0);
    assert.equal(app.timers.size, 0);
});

test('vision toggle limits the hub to configs with an mmproj projector', () => {
    const app = loadApp();
    app.run(`servers = [
        {running: false, health: 'stopped', config: {id: 'text', name: 'Text', model_path: '/m/text.gguf', host: '127.0.0.1', port: 8080, mmproj_path: ''}},
        {running: false, health: 'stopped', config: {id: 'blank', name: 'Blank', model_path: '/m/blank.gguf', host: '127.0.0.1', port: 8081, mmproj_path: '   '}},
        {running: true, health: 'healthy', config: {id: 'vision', name: 'Vision', model_path: '/m/vision.gguf', host: '127.0.0.1', port: 8082, mmproj_path: '/m/mmproj.gguf'}},
    ]`);
    const visibleIds = () => JSON.parse(app.run('JSON.stringify(filteredServers().map(s => s.config.id))'));
    assert.deepEqual(visibleIds(), ['text', 'blank', 'vision']);
    app.run('hubVisionOnly = true');
    assert.deepEqual(visibleIds(), ['vision']);
    app.run("hubStateFilter = 'stopped'");
    assert.deepEqual(visibleIds(), []);
});

test('model selection is shared by chat, logs, benchmarks, and token usage', () => {
    const app = loadApp();
    app.context.rememberConfig('selected');
    assert.equal(app.run('[chatConfigId, currentTerminalServerId, benchmarkConfigId, tokenCalculatorConfigId].every(id => id === "selected")'), true);
});

test('Unlimited can be toggled without losing the finite output limit', () => {
    const app = loadApp();
    app.run("openModal({id: 'model', name: 'Model', model_path: '/tmp/model.gguf', n_predict: 2048})");
    app.elements.get('config-output-unlimited').checked = true;
    app.context.syncOutputLimit();
    assert.equal(app.run('formConfigData().n_predict'), -1);
    assert.equal(app.elements.get('config-output-tokens').disabled, true);
    app.elements.get('config-output-unlimited').checked = false;
    app.context.syncOutputLimit();
    assert.equal(app.run('formConfigData().n_predict'), 2048);
});

test('API validation errors preserve field locations for inline feedback', async () => {
    const app = loadApp();
    const fields = [{loc: ['body', 'model_path'], msg: 'Choose a GGUF file'}];
    const error = await app.context.apiError({json: async () => ({detail: fields})});
    assert.equal(error.message, 'Choose a GGUF file');
    assert.deepEqual(error.fields, fields);
});

test('refreshing a page cannot move focus behind an open dialog', () => {
    const app = loadApp();
    let focused = false;
    app.context.document.getElementById('saved-field').focus = () => { focused = true; };
    app.run(`
        pageStates.set('configs', {fields: {}, scroll: [], y: 0, focus: 'saved-field'});
        dialogStack.push({overlay: {}});
        restorePageState('configs');
    `);
    assert.equal(focused, false);
    app.run("dialogStack.pop(); restorePageState('configs')");
    assert.equal(focused, true);
});

function chatReply(app, message, finishReason = 'stop') {
    const data = JSON.stringify({choices: [{message, finish_reason: finishReason}]});
    return JSON.parse(app.run(`JSON.stringify(extractChatReply(${data}))`));
}

test('chat separates reasoning the server returns in its own field', () => {
    const app = loadApp();
    const reply = chatReply(app, {content: 'Paris.', reasoning_content: 'The capital of France is Paris.'});
    assert.equal(reply.content, 'Paris.');
    assert.equal(reply.reasoning, 'The capital of France is Paris.');
});

for (const [name, raw] of [
    ['think tags', '<think>\nCount the letters.\n</think>\n\nThree.'],
    ['a closing tag whose opening tag was in the prompt', 'Count the letters.\n</think>\n\nThree.'],
    ['thinking tags', '<THINKING>Count the letters.</THINKING>Three.'],
    ['gpt-oss channels', '<|channel|>analysis<|message|>Count the letters.<|end|><|start|>assistant<|channel|>final<|message|>Three.<|return|>'],
]) {
    test(`chat separates inline reasoning in ${name}`, () => {
        const reply = chatReply(loadApp(), {content: raw});
        assert.equal(reply.content, 'Three.');
        assert.equal(reply.reasoning, 'Count the letters.');
    });
}

test('chat flags replies that ran out of tokens while still reasoning', () => {
    const app = loadApp();
    const reply = chatReply(app, {content: '<think>Still working through the'}, 'length');
    assert.equal(reply.content, '');
    assert.equal(reply.reasoning, 'Still working through the');
    assert.equal(reply.truncated, true);
    const html = app.run(`renderChatMessages([${JSON.stringify({role: 'assistant', ...reply})}])`);
    assert.match(html, /class="chat-reasoning"/);
    assert.match(html, /never reached a final answer/);
});

test('chat history sent to the model excludes reasoning', () => {
    const app = loadApp();
    const payload = JSON.parse(app.run(`JSON.stringify(chatRequestPayload([
        {role: 'user', content: 'Hi'},
        {role: 'assistant', content: 'Hello!', reasoning: 'Greet back.'},
        {role: 'user', content: 'Again'},
    ]))`));
    assert.deepEqual(payload.messages[1], {role: 'assistant', content: 'Hello!'});
});

test('plain replies render without a thought process block', () => {
    const app = loadApp();
    const reply = chatReply(app, {content: 'Just an answer.'});
    assert.deepEqual([reply.content, reply.reasoning], ['Just an answer.', '']);
    assert.doesNotMatch(app.run(`renderChatMessages([${JSON.stringify({role: 'assistant', ...reply})}])`), /chat-reasoning/);
});

// Serve an SSE body in arbitrary byte-sized pieces, like a real network would.
function sseResponse(events, pieceSize = 7) {
    const text = events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
    const bytes = new TextEncoder().encode(text);
    let position = 0;
    return {
        ok: true,
        status: 200,
        headers: {get: () => 'text/event-stream'},
        body: new ReadableStream({
            pull(controller) {
                if (position >= bytes.length) return controller.close();
                controller.enqueue(bytes.slice(position, position += pieceSize));
            },
        }),
    };
}

function loadStreamingApp(respond) {
    const app = loadApp();
    Object.assign(app.context, {TextDecoder, TextEncoder, ReadableStream, AbortController});
    app.requests = [];
    app.context.fetch = async (url, options = {}) => {
        app.requests.push({url, options});
        if (url.endsWith('/chat/completions')) return respond(options);
        return {ok: true, json: async () => []};
    };
    return app;
}

const delta = (fields, finish = null) => ({choices: [{delta: fields, finish_reason: finish}]});

test('chat streams inline reasoning and answer from chunks split mid-tag', async () => {
    const app = loadStreamingApp(() => sseResponse([
        delta({role: 'assistant'}),
        delta({content: '<think>Count the '}),
        delta({content: 'letters.</think>\n\nThere are '}),
        delta({content: '**3**.'}, 'stop'),
        {choices: [], usage: {prompt_tokens: 5, completion_tokens: 9, total_tokens: 14}},
        '[DONE]',
    ]));
    app.run('streamReply = {role: "assistant", content: "", reasoning: "", streaming: true}');
    await app.run('streamChatCompletion("cfg", {messages: []}, streamReply, undefined)');
    const reply = JSON.parse(app.run('JSON.stringify(streamReply)'));
    assert.equal(reply.reasoning, 'Count the letters.');
    assert.equal(reply.content, 'There are **3**.');
    assert.equal(reply.truncated, false);
    const body = JSON.parse(app.requests[0].options.body);
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, {include_usage: true});
});

test('chat streams reasoning sent as a separate field and flags truncation', async () => {
    const app = loadStreamingApp(() => sseResponse([
        delta({reasoning_content: 'Long '}),
        delta({reasoning_content: 'thinking'}, 'length'),
    ]));
    app.run('streamReply = {role: "assistant", content: "", reasoning: "", streaming: true}');
    await app.run('streamChatCompletion("cfg", {messages: []}, streamReply, undefined)');
    const reply = JSON.parse(app.run('JSON.stringify(streamReply)'));
    assert.deepEqual([reply.reasoning, reply.content, reply.truncated], ['Long thinking', '', true]);
});

test('chat surfaces errors sent inside the stream', async () => {
    const app = loadStreamingApp(() => sseResponse([
        delta({content: 'Partial'}),
        {error: {code: 500, message: 'slot crashed'}},
    ]));
    app.run('streamReply = {role: "assistant", content: "", reasoning: "", streaming: true}');
    await assert.rejects(app.run('streamChatCompletion("cfg", {messages: []}, streamReply, undefined)'), /slot crashed/);
    assert.equal(app.run('streamReply.content'), 'Partial');
});

test('chat falls back to a whole JSON reply when the server does not stream', async () => {
    const app = loadStreamingApp(() => ({
        ok: true,
        headers: {get: () => 'application/json'},
        json: async () => ({choices: [{message: {content: '<think>hmm</think>Done.'}, finish_reason: 'stop'}]}),
    }));
    app.run('streamReply = {role: "assistant", content: "", reasoning: "", streaming: true}');
    await app.run('streamChatCompletion("cfg", {messages: []}, streamReply, undefined)');
    assert.deepEqual([app.run('streamReply.content'), app.run('streamReply.reasoning')], ['Done.', 'hmm']);
});

test('chat reports HTTP errors from llama-server and the proxy', async () => {
    const app = loadStreamingApp(() => ({
        ok: false, status: 400, statusText: 'Bad Request',
        json: async () => ({error: {message: 'context length exceeded'}}),
    }));
    await assert.rejects(app.run('streamChatCompletion("cfg", {messages: []}, {}, undefined)'), /context length exceeded/);
});

test('stopping a streamed reply keeps the partial answer', async () => {
    const app = loadStreamingApp(options => new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})));
    }));
    app.run(`fetchServers = async () => {}; chatConfigId = 'cfg'; document.getElementById('chat-input').value = 'Hello'`);
    const sending = app.run('sendChatMessage({preventDefault() {}})');
    assert.equal(app.run('chatSending'), true);
    // Enter-key submits (no submitter) must not stop the reply; the Stop button does.
    app.run('sendChatMessage({preventDefault() {}})');
    assert.equal(app.run('chatSending'), true);
    app.run('sendChatMessage({preventDefault() {}, submitter: {}})');
    await sending;
    const messages = JSON.parse(app.run('JSON.stringify(chatMessagesByConfig.cfg)'));
    assert.equal(messages.length, 2);
    assert.equal(messages[1].stopped, true);
    assert.equal(messages[1].streaming, false);
    assert.equal(app.run('chatSending'), false);
});

test('chat requests a reasoning-sized output budget by default', () => {
    const app = loadApp();
    assert.equal(app.run('chatRequestPayload([{role: "user", content: "Hi"}]).max_tokens'), 4096);
});

test('markdown renders common formatting', () => {
    const app = loadApp();
    const md = text => app.run(`renderMarkdown(${JSON.stringify(text)})`);
    assert.equal(md('**bold**, *em*, `a*b*`, ~~old~~'), '<p><strong>bold</strong>, <em>em</em>, <code>a*b*</code>, <del>old</del></p>');
    assert.equal(md('2 * 3 * 4 and snake_case_name'), '<p>2 * 3 * 4 and snake_case_name</p>');
    assert.equal(md('- a\n- b\n  1. c\n  2. d'), '<ul><li>a</li><li>b<ol><li>c</li><li>d</li></ol></li></ul>');
    assert.equal(md('3. three\n4. four'), '<ol start="3"><li>three</li><li>four</li></ol>');
    assert.match(md('## Heading'), /<h2 class="md-heading">Heading<\/h2>/);
    assert.match(md('| a | b |\n|---|--:|\n| 1 | 2 |'), /<th>a<\/th><th style="text-align:right">b<\/th>.*<td>1<\/td>/);
    assert.match(md('```py\nx = "<b>"\n```'), /<span class="md-lang">py<\/span>.*<code>x = &quot;&lt;b&gt;&quot;<\/code>/);
    // An unclosed fence (mid-stream) still renders as code.
    assert.match(md('```\nstill typing'), /<code>still typing<\/code>/);
});

test('markdown never emits model-supplied HTML or script links', () => {
    const app = loadApp();
    const html = app.run(`renderMarkdown(${JSON.stringify('<img src=x onerror=alert(1)>\n[x](javascript:alert(1)) [y](https://ok.example/?a=1&b="2")\n> <script>bad()</script>')})`);
    assert.doesNotMatch(html, /<img|<script|href="javascript/);
    assert.match(html, /href="https:\/\/ok\.example\/\?a=1&amp;b=&quot;2&quot;"/);
});
