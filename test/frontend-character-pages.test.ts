import assert from 'node:assert/strict';
import test from 'node:test';
import type { Character, CharacterPage } from '../shared/contracts';
import { createApiClient } from '../web/api';
import { createCharacterPages, emptyCharacterPages, resolveCatalogSelection, withSelectedCatalogOffset } from '../web/character-pages';
import { filterCharacters } from '../web/catalog';

function character(id: string, catalogOffset = 0): Character {
  return { id: `axon:${id}`, name: id, subtitle: '', description: '', initial: id[0], color: 'sage', greeting: '', source: 'axon', catalogOffset };
}
function harness() {
  let state = emptyCharacterPages();
  const calls: { offset: number; signal?: AbortSignal; resolve: (value: CharacterPage) => void; reject: (error: Error) => void }[] = [];
  let updates = 0;
  const controller = createCharacterPages((offset, options) => new Promise((resolve, reject) => {
    calls.push({ offset, signal: options.signal, resolve, reject });
  }), value => { state = value; updates++; });
  return { controller, calls, get state() { return state; }, get updates() { return updates; } };
}

test('opening, explicit more and refresh each fetch one page without prefetch; page duplicates keep their latest offset', async () => {
  const h = harness();
  const first = h.controller.refresh();
  assert.deepEqual(h.calls.map(call => call.offset), [0]);
  h.calls[0].resolve({ characters: [character('a'), character('b')], nextOffset: 24 });
  await first;
  assert.equal(h.calls.length, 1);
  assert.deepEqual(filterCharacters(h.state.characters, 'a', '', false).map(value => value.id), ['axon:a']);
  assert.equal(h.calls.length, 1, 'filtering loaded cards must not fetch');
  const more = h.controller.loadMore();
  await h.controller.loadMore();
  assert.deepEqual(h.calls.map(call => call.offset), [0, 24], 'duplicate clicks do not start duplicate page requests');
  h.calls[1].resolve({ characters: [character('b', 24), character('c', 24)], nextOffset: null });
  await more;
  assert.deepEqual(h.state.characters.map(value => [value.id, value.catalogOffset]), [['axon:a', 0], ['axon:b', 24], ['axon:c', 24]]);
  await h.controller.loadMore();
  assert.equal(h.calls.length, 2);
  const refresh = h.controller.refresh();
  h.calls[2].resolve({ characters: [character('fresh')], nextOffset: 24 });
  await refresh;
  assert.deepEqual(h.calls.map(call => call.offset), [0, 24, 0]);
  assert.deepEqual(h.state.characters.map(value => value.id), ['axon:fresh']);
});

test('page and refresh failures retain existing cards and retry the exact failed offset', async () => {
  const h = harness();
  const first = h.controller.refresh();
  h.calls[0].resolve({ characters: [character('a')], nextOffset: 24 });
  await first;
  const more = h.controller.loadMore();
  h.calls[1].reject(new Error('暂时无法读取'));
  await more;
  assert.equal(h.state.error, '暂时无法读取');
  assert.deepEqual(h.state.characters.map(value => value.id), ['axon:a']);
  assert.equal(h.state.nextOffset, 24);
  const retry = h.controller.retry();
  h.calls[2].resolve({ characters: [character('b', 24)], nextOffset: 48 });
  await retry;
  const refresh = h.controller.refresh();
  h.calls[3].reject(new Error('刷新失败'));
  await refresh;
  assert.deepEqual(h.state.characters.map(value => value.id), ['axon:a', 'axon:b']);
  const retryRefresh = h.controller.retry();
  h.calls[4].resolve({ characters: [character('new')], nextOffset: 24 });
  await retryRefresh;
  assert.deepEqual(h.calls.map(call => call.offset), [0, 24, 24, 0, 0]);
  assert.deepEqual(h.state.characters.map(value => value.id), ['axon:new']);
  assert.equal(h.state.error, '');
});

test('refresh cancels pending more and ignores its late success or failure', async () => {
  for (const staleFailure of [false, true]) {
    const h = harness();
    const first = h.controller.refresh();
    h.calls[0].resolve({ characters: [character('a')], nextOffset: 24 });
    await first;
    const more = h.controller.loadMore();
    const refresh = h.controller.refresh();
    assert.equal(h.calls[1].signal?.aborted, true);
    h.calls[2].resolve({ characters: [character('fresh')], nextOffset: null });
    await refresh;
    if (staleFailure) h.calls[1].reject(new Error('old request failed'));
    else h.calls[1].resolve({ characters: [character('stale', 24)], nextOffset: 48 });
    await more;
    assert.deepEqual(h.state.characters.map(value => value.id), ['axon:fresh']);
    assert.equal(h.state.nextOffset, null);
    assert.equal(h.state.error, '');
    assert.equal(h.state.loading, false);
  }
});

test('refresh remains available while the first request is pending; only the last response can win', async () => {
  const h = harness();
  const initial = h.controller.refresh();
  const refresh = h.controller.refresh();
  assert.equal(h.calls[0].signal?.aborted, true);
  h.calls[0].resolve({ characters: [character('stale')], nextOffset: 24 });
  await initial;
  assert.equal(h.state.loading, true);
  h.calls[1].resolve({ characters: [character('fresh')], nextOffset: null });
  await refresh;
  assert.deepEqual(h.state.characters.map(value => value.id), ['axon:fresh']);
});

test('leaving the library cancels requests and reopening creates a fresh first-page request', async () => {
  const h = harness();
  const pending = h.controller.refresh();
  h.controller.dispose();
  const updates = h.updates;
  assert.equal(h.calls[0].signal?.aborted, true);
  h.calls[0].resolve({ characters: [character('stale')], nextOffset: 24 });
  await pending;
  await h.controller.refresh();
  assert.equal(h.updates, updates);
  assert.equal(h.calls.length, 1);
  const reopened = harness();
  const fresh = reopened.controller.refresh();
  assert.equal(reopened.calls[0].offset, 0);
  reopened.calls[0].resolve({ characters: [], nextOffset: 24 });
  await fresh;
  assert.equal(reopened.calls.length, 1, 'an empty filtered page does not automatically crawl subsequent pages');
  assert.equal(reopened.state.nextOffset, 24);
});

test('page selection carries the exact offset through detail lookup and new-story creation', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const selected = character('second-page', 24);
  const client = createApiClient({ fetch: async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/characters?')) return Response.json({ characters: [selected], nextOffset: 48 });
    if (String(url).includes('/characters/')) return Response.json({ ...selected, catalogOffset: undefined });
    return Response.json({});
  } });
  const signal = new AbortController().signal;
  const page = await client.characterPage!(24, { signal });
  const seed = await resolveCatalogSelection(client, page.characters[0], signal);
  assert.equal(seed.catalogOffset, 24);
  await client.createSession(withSelectedCatalogOffset({ characterId: seed.id, dynamicOpening: false }, seed));
  assert.deepEqual(calls.map(call => call.url), ['/api/characters?offset=24', '/api/characters/axon%3Asecond-page?offset=24', '/api/sessions']);
  assert.equal(calls[0].init?.signal, signal);
  assert.equal(calls[1].init?.signal, signal);
  assert.deepEqual(JSON.parse(String(calls[2].init?.body)), { characterId: selected.id, dynamicOpening: false, catalogOffset: 24 });
});

test('existing worlds, samples and unrelated seeds never receive catalog transport metadata', () => {
  const selected = character('selected', 72);
  for (const input of [
    { characterId: selected.id, worldId: 'saved-world', catalogOffset: 72 },
    { characterId: 'sample', catalogOffset: 72 },
    { characterId: 'other', catalogOffset: 72 },
  ]) assert.equal('catalogOffset' in withSelectedCatalogOffset(input, selected), false);
  assert.equal('catalogOffset' in withSelectedCatalogOffset({ characterId: selected.id }, { ...selected, source: 'sample' }), false);
});
