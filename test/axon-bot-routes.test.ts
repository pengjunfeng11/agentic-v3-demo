import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';
import { createAxonBotCatalog } from '../server/axon-bots.ts';
import type { StoryRuntime } from '../server/runtime.ts';
import type { StoryStore } from '../server/store.ts';
import type { ResolvedExternalCharacter } from '../server/external-character.ts';

const hidden = 'PRIVATE_AXON_DEFINITION';
const forged = 'FORGED_CLIENT_DEFINITION';
const at = '2026-11-24T00:00:00.000Z';
const characterId = 'axon:bot-1';
const upstreamPrompt = { id: 'bot-1', title: '公开角色', description: '公开简介', welcomeMessage: '欢迎',
  accessibility: true, live: true, visibility: false, language: 'en', coverURL: 'https://cdn.example/cover.png', updatedAt: at,
  initPrompt: hidden, extraPrivateField: hidden };
const safe = (value: unknown) => assert.doesNotMatch(typeof value === 'string' ? value : JSON.stringify(value), /PRIVATE_AXON|FORGED_CLIENT|definition|provenance|init_prompt|initPrompt|sourceRevision/);

async function fixture() {
  const upstreamCalls: string[] = [];
  const creates: any[][] = [];
  let offline = false, publicAccess = true, seedCalls = 0;
  let saved: ResolvedExternalCharacter | undefined;
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  const catalog = createAxonBotCatalog({ nodeBaseUrl: 'http://node.test', axonRpcUrl: 'http://axon.test/rpc', now: () => Date.parse(at),
    fetch: async (input, init) => {
      const url = new URL(String(input)); upstreamCalls.push(url.pathname);
      assert.equal(new Headers(init?.headers).get('authorization'), null);
      if (offline) throw new Error(hidden);
      if (url.pathname === '/prompt/v2/filter') return json({ prompts: [upstreamPrompt] });
      if (url.pathname === '/prompt/bot-1') return json({ prompt: { ...upstreamPrompt, accessibility: publicAccess } });
      if (url.pathname === '/rpc') {
        const body = JSON.parse(String(init?.body));
        return json({ jsonrpc: '2.0', id: body.id, result: { found: true, prompt: {
          id: 'bot-1', title: '公开角色', init_prompt: hidden, welcome_message: '欢迎', privateFutureField: hidden,
        } } });
      }
      throw new Error('Unexpected upstream URL');
    } });
  const legacy = { id: 'legacy', name: '旧角色', subtitle: '', description: '旧简介', initial: '旧', color: 'sage', greeting: '旧开场', definition: hidden };
  const world = () => ({ id: 'w1', title: '故事', revision: 1, createdAt: at, events: [],
    entities: [{ id: characterId, kind: 'npc', name: saved?.name ?? '公开角色', description: '公开简介',
      createdAt: at, updatedAt: at, version: 1, knownByCharacterIds: [characterId], sourceTurnId: 'seed',
      state: { definition: saved?.definition ?? hidden, externalCharacterProvenance: saved?.provenance ?? { private: hidden },
        characterSource: 'axon', characterSubtitle: '热门推荐', characterLanguage: 'en',
        characterThumbnailUrl: 'https://cdn.example/cover.png', characterCoverUrl: 'https://cdn.example/cover.png' } }],
    scene: { location: '书店', presentCharacterIds: [characterId] }, playerProfile: null });
  const session = { id: 's1', worldId: 'w1', characterId, title: '对话', createdAt: at, updatedAt: at, dynamicOpening: false };
  const user = { id: 'u1', turnId: 't1', sessionId: 's1', role: 'user', content: '你好', createdAt: at, kind: 'dialogue' };
  const assistant = { id: 'a1', turnId: 't1', sessionId: 's1', role: 'assistant', content: '公开回答', createdAt: at, status: 'committed' };
  const detail = () => ({ session, world: world(), messages: [assistant], hasMore: false, nextBefore: null, privateSnapshot: hidden });
  const store = {
    ensureSeed: async () => { seedCalls++; },
    listCharacters: async () => [legacy], listSessions: async () => [session], listWorlds: async () => [world()],
    createSession: async (...args: any[]) => { creates.push(args); saved = args[4] ?? saved; return detail(); },
    getSession: async () => detail(), getWorld: async () => world(),
    messagePage: async () => ({ messages: [assistant], hasMore: false, nextBefore: null }),
    beginTurn: async () => ({ id: 't1', ownerId: 'guest', worldId: 'w1', sessionId: 's1', status: 'committed', attempt: 'one', replayed: true }),
    getTurn: async () => ({ id: 't1', sessionId: 's1', worldId: 'w1', status: 'committed', phase: 'planning', userMessage: user,
      assistantMessage: assistant, assistantMessages: [assistant], privateSnapshot: hidden }),
  } as unknown as StoryStore;
  const runtime = { status: { provider: 'demo' }, prompts: {}, metadata: {},
    actor: async () => { throw new Error('No model call is allowed in this fixture'); },
    updateWorld: async () => { throw new Error('No model call is allowed in this fixture'); },
  } as unknown as StoryRuntime;
  const app = createApp({ store, runtime, characterCatalog: catalog, authenticate: req => req.get('x-guest') ?? '' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { upstreamCalls, creates, saved: () => saved, seedCalls: () => seedCalls,
    setOffline: () => { offline = true; }, revoke: () => { publicAccess = false; },
    request: (path: string, method = 'GET', body?: unknown, authenticated = true) => fetch(base + path, {
      method, headers: { ...(authenticated ? { 'x-guest': 'guest' } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    close: async () => { await app.locals.shutdown(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}

test('authenticated public bootstrap/selection exposes only Bot display fields and never seeds an external world', async () => {
  const f = await fixture();
  try {
    const bootstrap = await f.request('/api/bootstrap');
    assert.equal(bootstrap.status, 200);
    const body = await bootstrap.json(); safe(body);
    assert.deepEqual(body.characters.map((card: any) => card.id), [characterId, 'legacy']);
    assert.deepEqual(body.characterCatalog, { source: 'axon-hot', status: 'ready', limit: 24 });
    assert.equal(f.seedCalls(), 0);
    const selected = await f.request('/api/characters/' + encodeURIComponent(characterId));
    assert.equal(selected.status, 200);
    const card = await selected.json(); safe(card);
    assert.equal(card.source, 'axon'); assert.equal(card.name, '公开角色');
    assert.equal(f.creates.length, 0);
    assert.deepEqual(f.upstreamCalls, ['/prompt/v2/filter', '/prompt/bot-1', '/rpc']);
  } finally { await f.close(); }
});

test('new session resolves again after selection and only trusted server data reaches the store', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/api/characters/' + encodeURIComponent(characterId))).status, 200);
    const result = await f.request('/api/sessions', 'POST', { characterId, dynamicOpening: false,
      definition: forged, source: 'legacy', externalCharacter: { id: characterId, definition: forged },
      provenance: { kind: 'axon', botId: 'private-bot', sourceRevision: forged },
    });
    assert.equal(result.status, 201); safe(await result.json());
    assert.equal(f.creates.length, 1);
    const [owner, id, worldId, options, resolved] = f.creates[0];
    assert.equal(owner, 'guest'); assert.equal(id, characterId); assert.equal(worldId, undefined);
    assert.deepEqual(options, { dynamicOpening: false });
    assert.equal(resolved.definition, hidden);
    assert.equal(resolved.provenance.botId, 'bot-1');
    assert.doesNotMatch(JSON.stringify(f.creates), /FORGED_CLIENT/);
    assert.deepEqual(f.upstreamCalls, ['/prompt/v2/filter', '/prompt/bot-1', '/rpc', '/prompt/bot-1', '/rpc']);
  } finally { await f.close(); }
});

test('withdrawal between selection and creation prevents both Axon access and persistence', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/api/characters/' + encodeURIComponent(characterId))).status, 200);
    f.revoke();
    const response = await f.request('/api/sessions', 'POST', { characterId });
    assert.equal(response.status, 404); safe(await response.json());
    assert.equal(f.creates.length, 0);
    assert.deepEqual(f.upstreamCalls, ['/prompt/v2/filter', '/prompt/bot-1', '/rpc', '/prompt/bot-1']);
  } finally { await f.close(); }
});

test('unknown Bots and unauthenticated requests cannot access raw upstream data or the store', async () => {
  const f = await fixture();
  try {
    for (const [path, method, body] of [
      ['/api/bootstrap', 'GET'], ['/api/characters/axon%3Abot-1', 'GET'], ['/api/sessions', 'POST', { characterId }],
    ] as const) {
      const response = await f.request(path, method, body, false);
      assert.equal(response.status, 401); safe(await response.json());
    }
    assert.equal(f.upstreamCalls.length, 0); assert.equal(f.creates.length, 0);
    for (const [path, method, body] of [
      ['/api/characters/axon%3Aprivate-bot', 'GET'], ['/api/sessions', 'POST', { characterId: 'axon:private-bot', definition: forged }],
    ] as const) {
      const response = await f.request(path, method, body);
      assert.equal(response.status, 404); safe(await response.json());
    }
    assert.deepEqual(f.upstreamCalls, ['/prompt/v2/filter']);
    assert.equal(f.creates.length, 0);
  } finally { await f.close(); }
});

test('existing world sessions and recovery use their snapshot even when the upstream is offline; JSON and SSE stay private', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/api/sessions', 'POST', { characterId })).status, 201);
    const count = f.upstreamCalls.length;
    f.setOffline();
    const continued = await f.request('/api/sessions', 'POST', { characterId, worldId: 'w1', expectedRevision: 1,
      externalCharacter: { definition: forged }, definition: forged, source: 'axon' });
    assert.equal(continued.status, 201); safe(await continued.json());
    assert.equal(f.creates[1][4], undefined, 'Existing world requests must not resolve or pass a fresh external card');
    assert.deepEqual(f.creates[1][3], { expectedRevision: 1 });
    for (const path of ['/api/worlds/w1', '/api/sessions/s1', '/api/sessions/s1/messages', '/api/turns/t1']) {
      const response = await f.request(path); assert.equal(response.status, 200); safe(await response.json());
    }
    const stream = await f.request('/api/sessions/s1/turns', 'POST', { clientTurnId: 'replay', content: '你好' });
    assert.equal(stream.status, 200);
    const body = await stream.text(); safe(body);
    assert.match(body, /event: accepted/); assert.match(body, /event: committed/); assert.match(body, /公开回答/);
    assert.equal(f.saved()?.definition, hidden, 'Public projection does not mutate the private runtime snapshot');
    assert.equal(f.upstreamCalls.length, count);
  } finally { await f.close(); }
});

test('catalog failure reports an unavailable state but does not block bootstrap of saved stories', async () => {
  const f = await fixture();
  try {
    f.setOffline();
    const response = await f.request('/api/bootstrap');
    assert.equal(response.status, 200);
    const body = await response.json(); safe(body);
    assert.deepEqual(body.characterCatalog, { source: 'axon-hot', status: 'unavailable', limit: 24 });
    assert.equal(body.worlds[0].id, 'w1');
    assert.deepEqual(body.characters.map((card: any) => card.id), ['legacy']);
  } finally { await f.close(); }
});
