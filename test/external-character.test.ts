import test from 'node:test';
import assert from 'node:assert/strict';
import { validateExternalCharacter, type ResolvedExternalCharacter } from '../server/external-character.ts';
import { publicBootstrap, publicCharacter, publicSessionDetail, publicWorld } from '../server/public-view.ts';
import { worldCharacters } from '../web/world-model.ts';
import { postgresFixture } from './pg-helper.ts';

function card(): ResolvedExternalCharacter {
  return { id: 'axon:public-bot-1', name: '星港向导', subtitle: '公开推荐角色', description: '守候在星港的向导。',
    initial: '星', color: 'blue', greeting: '  欢迎来到星港。\n请跟我来。  ', definition: '  PRIVATE_PERSONA_SENTINEL\n完整设定，不得截断。  ',
    thumbnailUrl: 'https://example.com/original-avatar.webp', coverUrl: 'https://example.com/original-cover.webp',
    language: 'zh-CN', source: 'axon',
    provenance: { kind: 'axon', botId: 'public-bot-1', fetchedAt: '2026-11-24T00:00:00.000Z', sourceRevision: 'PRIVATE_REVISION_SENTINEL' } };
}

test('external card validation retains exact authored text, copies only its schema, and rejects invalid or oversized fields', () => {
  const original = card();
  const resolved = validateExternalCharacter({ ...original, catalogOffset: 24, rawUpstream: 'do-not-copy', provenance: { ...original.provenance, credential: 'do-not-copy' } }, original.id);
  assert.deepEqual(resolved, original);
  original.provenance.sourceRevision = 'later';
  assert.equal(resolved.provenance.sourceRevision, 'PRIVATE_REVISION_SENTINEL');
  for (const changed of [
    { id: 'other' }, { source: 'legacy' }, { name: '字'.repeat(121) }, { description: '字'.repeat(6001) },
    { definition: '字'.repeat(12001) }, { greeting: '字'.repeat(12001) }, { definition: '' },
    { thumbnailUrl: 'javascript:alert(1)' }, { coverUrl: 'https://user:secret@example.com/image' },
    { provenance: { ...original.provenance, botId: 'other-bot' } },
    { provenance: { ...original.provenance, fetchedAt: 'invalid' } },
  ]) assert.throws(() => validateExternalCharacter({ ...original, ...changed }, original.id), { code: 'EXTERNAL_CHARACTER_INVALID', status: 422 });
});

test('public card projection never returns private external definition or provenance', () => {
  const projected = publicCharacter(card());
  assert.equal(projected.source, 'axon');
  assert.equal(projected.thumbnailUrl, card().thumbnailUrl);
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_|definition|provenance|sourceRevision/);
});

test('public bootstrap catalog status projects only source, status, page size and next offset', () => {
  const characterCatalog = { source: 'axon-hot' as const, status: 'unavailable' as const, limit: 24, nextOffset: 0,
    error: 'PRIVATE_UPSTREAM_FAILURE', rawPayload: { credential: 'PRIVATE_TOKEN' } };
  const result = publicBootstrap({ characters: [card()], sessions: [], worlds: [], status: { provider: 'live' }, characterCatalog });
  assert.deepEqual(result.characterCatalog, { source: 'axon-hot', status: 'unavailable', limit: 24, nextOffset: 0 });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|rawPayload|credential|definition|provenance/);
});

test('world updates cannot forge external authored metadata while ordinary NPC state remains writable', async () => {
  const f = await postgresFixture();
  try {
    const original = card();
    const detail = await f.store.createSession('alice', original.id, undefined, {}, original);
    const initial = detail.world.entities![0].state;
    const turn = await f.store.beginTurn('alice', detail.session.id, 'external-metadata-guard', '请保留原来的设定。');
    for (const [key, value] of Object.entries({
      characterSource: 'sample', characterSubtitle: '伪造来源',
      characterThumbnailUrl: 'https://example.com/forged-avatar.webp', characterCoverUrl: 'https://example.com/forged-cover.webp',
      characterLanguage: 'en', externalCharacterProvenance: { kind: 'axon', botId: 'another-bot' },
    })) {
      await assert.rejects(f.store.commit(turn, '向导点了点头。', [], { entityChanges: [{ op: 'update', entity: {
        id: original.id, kind: 'npc', name: original.name, description: original.description, state: { [key]: value },
      } }] }), { code: 'ENTITY_INVALID' });
      assert.deepEqual((await f.store.getWorld('alice', detail.world.id)).entities![0].state, initial);
    }
    await f.store.commit(turn, '向导点了点头。', [], { entityChanges: [{ op: 'update', entity: {
      id: original.id, kind: 'npc', name: original.name, description: original.description, state: { mood: '平静' },
    } }] });
    const state = (await f.store.getWorld('alice', detail.world.id)).entities![0].state;
    assert.equal(state.mood, '平静');
    assert.equal(state.definition, original.definition);
    assert.deepEqual(state.externalCharacterProvenance, original.provenance);
  } finally { await f.cleanup(); }
});

for (const livingWorld of [false, true]) test(`external root snapshots isolate owners and survive upstream/catalog changes (livingWorld=${livingWorld})`, async () => {
  const f = await postgresFixture({ livingWorld });
  try {
    const original = card();
    const beforeCatalog = await f.store.listCharacters();
    const legacy = await f.store.createSession('alice', 'lin-wan');
    const legacyMessages = legacy.messages;
    const alice = await f.store.createSession('alice', original.id, undefined, {}, original);
    assert.deepEqual(await f.store.listCharacters(), beforeCatalog, 'external roots must not write the shared catalog');
    assert.equal(alice.world.entities?.length, 1);
    assert.equal(alice.world.entities![0].state.definition, original.definition);
    assert.deepEqual(alice.world.entities![0].state.externalCharacterProvenance, original.provenance);
    assert.deepEqual(alice.messages.map(message => message.content), [original.greeting]);
    assert.equal((await f.store.previewInput('alice', alice.session.id, '你好')).character.definition, original.definition);
    await assert.rejects(f.store.getSession('bob', alice.session.id), { code: 'SESSION_NOT_FOUND' });
    await assert.rejects(f.store.createSession('bob', original.id, alice.world.id), { code: 'WORLD_NOT_FOUND' });
    await assert.rejects(f.store.createSession('alice', original.id, alice.world.id, {}, original), { code: 'EXTERNAL_CHARACTER_WORLD_SCOPE' });
    await assert.rejects(f.store.createSession('alice', 'axon:unknown-bot', alice.world.id), { code: 'CHARACTER_NOT_FOUND' });
    await assert.rejects(f.store.createSession('alice', 'axon:wrong-id', undefined, {}, original), { code: 'EXTERNAL_CHARACTER_INVALID' });

    const updated = { ...card(), name: '更新后的向导', definition: 'BOB_NEW_PERSONA',
      thumbnailUrl: 'https://example.com/new-avatar.webp', provenance: { ...card().provenance, sourceRevision: 'new-revision' } };
    const bob = await f.store.createSession('bob', original.id, undefined, {}, updated);
    assert.notEqual(bob.world.id, alice.world.id);
    assert.equal((await f.store.previewInput('bob', bob.session.id, '你好')).character.definition, updated.definition);
    original.definition = 'MUTATED_CALLER_OBJECT'; original.provenance.sourceRevision = 'mutated';

    // A future global catalog entry with the same external ID must not replace the frozen persona.
    await f.migrationPool.query('INSERT INTO characters(id,name,subtitle,description,definition,initial,color,greeting,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [card().id, '目录新名称', '', '目录新简介', 'GLOBAL_CATALOG_PERSONA', '目', 'sage', '目录新开场', 99]);
    const continued = await f.store.createSession('alice', card().id, alice.world.id);
    assert.deepEqual(continued.messages, [], 'a continuation does not replay the authored greeting');
    const input = await f.store.previewInput('alice', continued.session.id, '继续聊。');
    assert.equal(input.character.definition, card().definition);
    assert.doesNotMatch(JSON.stringify(input), /PRIVATE_REVISION_SENTINEL|externalCharacterProvenance|characterThumbnailUrl/);
    const publicDetail = publicSessionDetail(await f.store.getSession('alice', alice.session.id));
    assert.doesNotMatch(JSON.stringify(publicDetail), /PRIVATE_|definition|provenance|sourceRevision|externalCharacterProvenance/i);
    const restored = worldCharacters(publicDetail.world, [publicCharacter(updated)])[0];
    assert.equal(restored.name, card().name);
    assert.equal(restored.source, 'axon');
    assert.equal(restored.thumbnailUrl, card().thumbnailUrl);
    assert.equal(restored.coverUrl, card().coverUrl);
    assert.equal(restored.language, card().language);
    assert.equal(restored.subtitle, card().subtitle);
    assert.deepEqual((await f.store.getSession('alice', legacy.session.id)).messages, legacyMessages);
    assert.equal((await f.store.previewInput('alice', legacy.session.id, '你好')).character.name, '林晚');

    const externalWorld = await f.store.getWorld('alice', alice.world.id);
    externalWorld.entities![0].state.characterThumbnailUrl = 'javascript:alert(1)';
    externalWorld.entities![0].state.characterCoverUrl = 'https://user:password@example.com/private';
    const safe = publicWorld(externalWorld).entities![0].state;
    assert(!('characterThumbnailUrl' in safe)); assert(!('characterCoverUrl' in safe));
  } finally { await f.cleanup(); }
});
