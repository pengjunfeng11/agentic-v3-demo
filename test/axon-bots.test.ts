import test from 'node:test';
import assert from 'node:assert/strict';
import { createAxonBotCatalog, HOT_BOT_LIMIT, type AxonBotOptions } from '../server/axon-bots.ts';

const privateDefinition = '  PRIVATE_AXON_DEFINITION\n完整原始设定。  ';
const at = Date.parse('2026-11-24T00:00:00.000Z');
function prompt(id = 'bot-1', extra: Record<string, unknown> = {}) {
  return { id, title: `角色 ${id}`, description: '公开简介', welcomeMessage: '公开开场', live: true, accessibility: true,
    visibility: false, language: 'en', updatedAt: '2026-11-23T10:00:00.000Z', thumbnailURL: 'https://cdn.example/avatar.png',
    coverURL: 'https://cdn.example/cover.png', initPrompt: privateDefinition, ...extra };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
type Call = { url: URL; init: RequestInit; body: Record<string, any> | undefined };
type Reply = (call: Call) => Response | Promise<Response>;
function fixture(options: Partial<AxonBotOptions> = {}) {
  const calls: Call[] = [];
  let feed: Reply = () => json({ prompts: [prompt()] });
  let detail: Reply = () => json({ prompt: prompt() });
  let rpc: Reply = call => json({ jsonrpc: '2.0', id: call.body?.id, result: { found: true, i18n: false,
    prompt: { id: 'bot-1', title: 'Axon 原名', init_prompt: privateDefinition, welcome_message: '  原始开场\n保持空白。  ', thumbnail_url: 'https://cdn.example/raw.png' } } });
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const call = { url: new URL(String(input)), init, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    if (call.url.pathname === '/prompt/v2/filter') return feed(call);
    if (call.url.pathname.startsWith('/prompt/')) return detail(call);
    if (call.url.href === 'http://axon.test/rpc') return rpc(call);
    throw new Error('Unexpected upstream request');
  };
  return { calls, catalog: createAxonBotCatalog({ nodeBaseUrl: 'http://node.test', axonRpcUrl: 'http://axon.test/rpc', now: () => at, ...options, fetch: fakeFetch }),
    feed: (reply: Reply) => { feed = reply; }, detail: (reply: Reply) => { detail = reply; }, rpc: (reply: Reply) => { rpc = reply; } };
}

test('hot feed requests exactly the official top 24 anonymously, keeps order, deduplicates and projects only display fields', async () => {
  const f = fixture();
  const rows = Array.from({ length: 25 }, (_, i) => prompt(`bot-${i}`, { uses: 25 - i }));
  rows[1] = prompt('bot-0');
  rows[2] = prompt('private', { accessibility: false });
  rows[3] = prompt('draft', { live: false });
  rows[4] = prompt('deleted', { deletedAt: '2026-11-23' });
  rows[5] = prompt('bad/id');
  rows[6] = prompt('untitled', { title: '' });
  f.feed(() => json({ prompts: rows }));
  const cards = await f.catalog.list();
  assert.equal(HOT_BOT_LIMIT, 24);
  assert.deepEqual(cards.map(card => card.id), ['axon:bot-0', ...Array.from({ length: 17 }, (_, i) => `axon:bot-${i + 7}`)]);
  assert(!cards.some(card => card.id === 'axon:bot-24'));
  assert.equal(cards[0].source, 'axon');
  assert.equal(cards[0].thumbnailUrl, 'https://cdn.example/avatar.png');
  assert.doesNotMatch(JSON.stringify(cards), /PRIVATE_|initPrompt|definition|provenance|uses|visibility/);
  const call = f.calls[0];
  assert.equal(call.url.origin, 'http://node.test');
  assert.equal(call.url.pathname, '/prompt/v2/filter');
  assert.deepEqual(Object.fromEntries(call.url.searchParams), { sort: 'top', take: '24', skip: '0', nsfw: 'false', language: 'en' });
  assert.equal(call.init.method, 'GET');
  assert.equal(call.init.redirect, 'error');
  assert(call.init.signal instanceof AbortSignal);
  const headers = new Headers(call.init.headers);
  assert.equal(headers.get('x-app-id'), '2');
  assert.equal(headers.get('authorization'), null);
  assert.equal(headers.get('cookie'), null);
  assert.equal(call.body, undefined);
});

test('concurrent feed reads share one request, return independent objects, expire, and do not serve stale cards after failure', async () => {
  let now = at;
  const f = fixture({ now: () => now, ttlMs: 1000 });
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  f.feed(async () => { await wait; return json({ prompts: [prompt()] }); });
  const first = f.catalog.list(), second = f.catalog.list();
  assert.equal(f.calls.length, 1);
  release();
  const [a, b] = await Promise.all([first, second]);
  a[0].name = 'caller mutation'; a.push(a[0]);
  assert.equal(b.length, 1); assert.notEqual(b[0].name, a[0].name);
  assert.deepEqual(await f.catalog.list(), b);
  assert.equal(f.calls.length, 1);
  now += 1000;
  f.feed(() => json({ private: privateDefinition }, 503));
  await assert.rejects(f.catalog.list(), { code: 'BOT_CATALOG_UNAVAILABLE', status: 503 });
  f.feed(() => json({ prompts: [prompt('new-bot')] }));
  assert.deepEqual((await f.catalog.list()).map(card => card.id), ['axon:new-bot']);
  assert.equal(f.calls.length, 3);
});

test('resolving a recommended hidden-definition Bot rechecks anonymous public access before every Axon request', async () => {
  const f = fixture();
  const first = await f.catalog.resolve('axon:bot-1');
  const second = await f.catalog.resolve('axon:bot-1');
  assert.deepEqual(f.calls.map(call => call.url.pathname), ['/prompt/v2/filter', '/prompt/bot-1', '/rpc', '/prompt/bot-1', '/rpc']);
  assert.equal(first.definition, privateDefinition);
  assert.equal(first.greeting, '  原始开场\n保持空白。  ');
  assert.equal(first.name, 'Axon 原名');
  assert.equal(first.description, '公开简介');
  assert.equal(first.language, 'en');
  assert.equal(first.thumbnailUrl, 'https://cdn.example/avatar.png');
  assert.deepEqual(first.provenance, { kind: 'axon', botId: 'bot-1', fetchedAt: new Date(at).toISOString(), sourceRevision: '2026-11-23T10:00:00.000Z' });
  assert.deepEqual(second, first);
  for (const call of f.calls) {
    assert.equal(new Headers(call.init.headers).get('authorization'), null);
    assert.equal(new Headers(call.init.headers).get('cookie'), null);
    assert.equal(call.init.redirect, 'error');
  }
  const request = f.calls[2];
  assert.equal(request.init.method, 'POST');
  assert.deepEqual(request.body, { jsonrpc: '2.0', id: request.body?.id, method: 'prompt.get', params: { id: 'bot-1' } });
  assert.equal(typeof request.body?.id, 'string');
  assert.notEqual(request.body?.id, f.calls[4].body?.id);
  assert.equal(new Headers(request.init.headers).get('x-app-id'), null);
});

test('unknown or malformed IDs never become arbitrary detail/RPC lookups', async () => {
  const f = fixture();
  for (const id of ['legacy', 'axon:', 'axon:../../private', 'axon:bot%2fprivate', 'axon:https://private', 'axon:' + 'a'.repeat(96)]) {
    await assert.rejects(f.catalog.resolve(id), { code: 'CHARACTER_NOT_FOUND', status: 404 });
  }
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.catalog.resolve('axon:not-recommended'), { code: 'CHARACTER_NOT_FOUND', status: 404 });
  assert.deepEqual(f.calls.map(call => call.url.pathname), ['/prompt/v2/filter']);
});

test('public detail denial, withdrawn state, or ID substitution fails before any raw Axon read', async () => {
  for (const reply of [
    ...[401, 403, 404, 410].map(status => () => json({ internal: privateDefinition }, status)),
    () => json({ prompt: prompt('different-id') }),
    () => json({ prompt: prompt('bot-1', { live: false }) }),
    () => json({ prompt: prompt('bot-1', { accessibility: false }) }),
    () => json({ prompt: prompt('bot-1', { deletedAt: '2026-11-24' }) }),
    () => json({ prompt: null }),
  ]) {
    const f = fixture(); f.detail(reply);
    await assert.rejects(f.catalog.resolve('axon:bot-1'), { code: 'CHARACTER_NOT_FOUND', status: 404 });
    assert.deepEqual(f.calls.map(call => call.url.pathname), ['/prompt/v2/filter', '/prompt/bot-1']);
  }
  const f = fixture();
  await f.catalog.resolve('axon:bot-1');
  f.detail(() => json({ prompt: prompt('bot-1', { live: false }) }));
  await assert.rejects(f.catalog.resolve('axon:bot-1'), { code: 'CHARACTER_NOT_FOUND' });
  assert.equal(f.calls.filter(call => call.url.pathname === '/rpc').length, 1, 'A cached feed cannot bypass a new public gate denial');
});

test('JSON-RPC errors, mismatched request or Bot IDs, and malformed results fail closed without private diagnostics', async () => {
  for (const invalid of [
    (id: string) => ({ jsonrpc: '2.0', id, error: { code: -1, message: privateDefinition } }),
    (id: string) => ({ jsonrpc: '1.0', id, result: {} }),
    () => ({ jsonrpc: '2.0', id: 'wrong-request', result: {} }),
    (id: string) => ({ jsonrpc: '2.0', id, result: { found: false } }),
    (id: string) => ({ jsonrpc: '2.0', id, result: { found: true, prompt: { id: 'other', init_prompt: privateDefinition } } }),
    (id: string) => ({ jsonrpc: '2.0', id, result: { found: true, prompt: null } }),
  ]) {
    const f = fixture(); f.rpc(call => json(invalid(call.body!.id)));
    await assert.rejects(f.catalog.resolve('axon:bot-1'), error => {
      assert.equal((error as any).code, 'BOT_CATALOG_UNAVAILABLE');
      assert.doesNotMatch(String(error), /PRIVATE_/);
      return true;
    });
  }
});

test('invalid or oversized authored definitions are rejected, not silently truncated', async () => {
  for (const definition of ['', 'x'.repeat(12001), 'bad\u0000definition']) {
    const f = fixture();
    f.rpc(call => json({ jsonrpc: '2.0', id: call.body?.id, result: { found: true,
      prompt: { id: 'bot-1', init_prompt: definition, welcome_message: 'Welcome' } } }));
    await assert.rejects(f.catalog.resolve('axon:bot-1'), { code: 'EXTERNAL_CHARACTER_INVALID', status: 422 });
  }
});

test('feed shape, JSON, network errors and response-size limits fail safely and allow a later retry', async () => {
  for (const reply of [
    () => json({ prompts: {} }), () => json([]), () => new Response('not json'),
    () => new Response('{}', { headers: { 'content-length': String(1024 * 1024 + 1) } }),
    () => new Response('x'.repeat(1024 * 1024 + 1)),
    () => { throw new Error(privateDefinition); },
    () => { throw new DOMException('timeout', 'AbortError'); },
  ]) {
    const f = fixture(); f.feed(reply);
    await assert.rejects(f.catalog.list(), error => {
      assert.equal((error as any).code, 'BOT_CATALOG_UNAVAILABLE');
      assert.doesNotMatch(String(error), /PRIVATE_/); return true;
    });
    f.feed(() => json({ prompts: [] }));
    assert.deepEqual(await f.catalog.list(), []);
  }
});

test('server endpoints reject embedded credentials, query strings, and unsupported protocols', () => {
  for (const options of [
    { nodeBaseUrl: 'https://user:secret@node.test' }, { nodeBaseUrl: 'http://node.test/path' },
    { nodeBaseUrl: 'http://node.test/?token=secret' }, { axonRpcUrl: 'http://axon.test/rpc#fragment' },
    { axonRpcUrl: 'file:///rpc' }, { axonRpcUrl: 'https://user:secret@axon.test/rpc' },
  ]) assert.throws(() => fixture(options));
});
