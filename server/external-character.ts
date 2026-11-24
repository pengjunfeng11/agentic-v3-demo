import type { Character } from '../shared/contracts.ts';
import { ServiceError } from './runtime.ts';

/** Server-resolved card. Never accept this object from an HTTP request body. */
export interface ResolvedExternalCharacter extends Character {
  source: 'axon';
  definition: string;
  provenance: { kind: 'axon'; botId: string; fetchedAt: string; sourceRevision?: string };
}

const text = (value: unknown, max: number, empty = false): value is string => typeof value === 'string'
  && (empty || Boolean(value.trim())) && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
function media(value: unknown): value is string | null | undefined {
  if (value === undefined || value === null) return true;
  if (!text(value, 2048)) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }
  catch { return false; }
}

/** Validate before opening the world transaction; preserve complete authored text. */
export function validateExternalCharacter(value: unknown, expectedId: string): ResolvedExternalCharacter {
  const card = value as Partial<ResolvedExternalCharacter> | null;
  const source = card?.provenance;
  if (!card || typeof card !== 'object' || card.source !== 'axon'
    || !text(card.id, 100) || card.id !== expectedId || !source || source.kind !== 'axon'
    || !text(source.botId, 95) || !/^[A-Za-z0-9_-]+$/.test(source.botId) || card.id !== 'axon:' + source.botId
    || !text(source.fetchedAt, 80) || !Number.isFinite(Date.parse(source.fetchedAt))
    || source.sourceRevision !== undefined && !text(source.sourceRevision, 256)
    || !text(card.name, 120) || !text(card.subtitle, 1000, true) || !text(card.description, 6000, true)
    || !text(card.initial, 8) || !['sage', 'blue', 'peach'].includes(card.color ?? '')
    || !text(card.definition, 12000) || !text(card.greeting, 12000, true)
    || card.language !== undefined && !text(card.language, 35)
    || !media(card.thumbnailUrl) || !media(card.coverUrl)) {
    throw new ServiceError('EXTERNAL_CHARACTER_INVALID', '角色卡内容无效或过长，请选择其他角色。', 422);
  }
  // The world snapshot only retains this schema, never an upstream raw response.
  return {
    id: card.id, name: card.name, subtitle: card.subtitle, description: card.description,
    initial: card.initial, color: card.color!, greeting: card.greeting, source: 'axon', definition: card.definition,
    ...(card.thumbnailUrl !== undefined ? { thumbnailUrl: card.thumbnailUrl } : {}),
    ...(card.coverUrl !== undefined ? { coverUrl: card.coverUrl } : {}),
    ...(card.language !== undefined ? { language: card.language } : {}),
    provenance: { kind: 'axon', botId: source.botId, fetchedAt: source.fetchedAt,
      ...(source.sourceRevision !== undefined ? { sourceRevision: source.sourceRevision } : {}) },
  };
}
