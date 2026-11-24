import { randomUUID } from 'node:crypto';
import type { Character } from '../shared/contracts.ts';
import { ServiceError } from './runtime.ts';
import { validateExternalCharacter, type ResolvedExternalCharacter } from './external-character.ts';

export const HOT_BOT_LIMIT = 24;
const MAX_RESPONSE_BYTES = 1024 * 1024;
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const botId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,95}$/.test(value);
const unavailable = () => new ServiceError('BOT_CATALOG_UNAVAILABLE', '热门角色暂时无法读取，请稍后重试。', 503);
const notFound = () => new ServiceError('CHARACTER_NOT_FOUND', '角色已不可用，请刷新热门列表。', 404);
function image(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
function publicPrompt(value: unknown, expectedId?: string): value is JsonObject & { id: string } {
  return object(value) && botId(value.id) && (!expectedId || value.id === expectedId)
    && value.live === true && value.accessibility === true && !value.deletedAt
    && typeof value.title === 'string' && value.title.trim().length > 0 && value.title.length <= 120
    && string(value.description).length <= 6000 && string(value.welcomeMessage).length <= 12000;
}
function summary(prompt: JsonObject & { id: string }): Character {
  const name = string(prompt.title);
  return { id: 'axon:' + prompt.id, name, subtitle: '热门推荐', description: string(prompt.description),
    initial: Array.from(name)[0], color: 'sage', greeting: string(prompt.welcomeMessage), source: 'axon',
    thumbnailUrl: image(prompt.thumbnailURL) || image(prompt.coverURL),
    coverUrl: image(prompt.coverURL) || image(prompt.backgroundURL) || image(prompt.thumbnailURL),
    language: string(prompt.language) || 'und' };
}
export interface HotBotCatalog {
  list(): Promise<Character[]>;
  resolve(characterId: string): Promise<ResolvedExternalCharacter>;
}
export interface AxonBotOptions {
  nodeBaseUrl: string;
  axonRpcUrl: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
}
/** Only the bounded official anonymous hot feed is indexed; no owned/private bot credentials. */
export function createAxonBotCatalog(options: AxonBotOptions): HotBotCatalog {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 60_000;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const base = new URL(options.nodeBaseUrl);
  const rpc = new URL(options.axonRpcUrl);
  for (const url of [base, rpc]) if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid server-side Bot endpoint');
  if (base.pathname !== '/') throw new Error('Node Bot endpoint must be an origin');
  let cached: { cards: Character[]; expires: number } | undefined;
  let loading: Promise<Character[]> | undefined;
  async function request(url: URL, body?: unknown, publicGate = false): Promise<JsonObject> {
    try {
      const response = await fetchImpl(url, { method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : { 'x-app-id': '2' }) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) { await response.body?.cancel(); throw publicGate && [401, 403, 404, 410].includes(response.status) ? notFound() : unavailable(); }
      const length = Number(response.headers.get('content-length'));
      if (length > MAX_RESPONSE_BYTES) { await response.body?.cancel(); throw unavailable(); }
      if (!response.body) throw unavailable();
      const chunks: Uint8Array[] = []; let size = 0;
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw unavailable(); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!object(result)) throw unavailable();
      return result;
    } catch (error) { if (error instanceof ServiceError) throw error; throw unavailable(); }
  }
  async function list(): Promise<Character[]> {
    if (cached && cached.expires > now()) return structuredClone(cached.cards);
    if (!loading) loading = (async () => {
      const url = new URL('/prompt/v2/filter', base);
      url.search = new URLSearchParams({ sort: 'top', take: String(HOT_BOT_LIMIT), skip: '0', nsfw: 'false', language: 'en' }).toString();
      const result = await request(url);
      if (!Array.isArray(result.prompts)) throw unavailable();
      const seen = new Set<string>();
      const cards = result.prompts.slice(0, HOT_BOT_LIMIT).filter((row): row is JsonObject & { id: string } => {
        if (!publicPrompt(row) || seen.has(row.id)) return false;
        seen.add(row.id); return true;
      }).map(summary);
      cached = { cards, expires: now() + ttlMs };
      return cards;
    })().finally(() => { loading = undefined; });
    return structuredClone(await loading);
  }
  async function resolve(characterId: string): Promise<ResolvedExternalCharacter> {
    const id = characterId.startsWith('axon:') ? characterId.slice(5) : '';
    if (!botId(id) || !(await list()).some(card => card.id === characterId)) throw notFound();
    // Recheck public access for every new story; the raw Axon RPC is not an ACL.
    const detail = await request(new URL('/prompt/' + encodeURIComponent(id), base), undefined, true);
    if (!publicPrompt(detail.prompt, id)) throw notFound();
    const requestId = randomUUID();
    const result = await request(rpc, { jsonrpc: '2.0', id: requestId, method: 'prompt.get', params: { id } });
    if (result.error || result.jsonrpc !== '2.0' || result.id !== requestId || !object(result.result) || result.result.found !== true
      || !object(result.result.prompt) || result.result.prompt.id !== id) throw unavailable();
    const raw = result.result.prompt;
    const publicCard = summary(detail.prompt);
    return validateExternalCharacter({ ...publicCard, name: string(raw.title) || publicCard.name,
      definition: string(raw.init_prompt), greeting: string(raw.welcome_message),
      provenance: { kind: 'axon', botId: id, fetchedAt: new Date(now()).toISOString(),
        ...(string(detail.prompt.updatedAt) ? { sourceRevision: string(detail.prompt.updatedAt) } : {}) } }, characterId);
  }
  return { list, resolve };
}
