import type { Character, CharacterPage } from '../shared/contracts';
import type { ApiClient, CreateSessionInput, RequestOptions } from './api';

export interface CharacterPagesState {
  characters: Character[];
  nextOffset: number | null;
  loading: boolean;
  error: string;
}
export const emptyCharacterPages = (): CharacterPagesState => ({ characters: [], nextOffset: 0, loading: false, error: '' });

/** One request per explicit action; a refresh supersedes any unfinished page. */
export function createCharacterPages(load: (offset: number, options: RequestOptions) => Promise<CharacterPage>, onChange: (state: CharacterPagesState) => void) {
  let state = emptyCharacterPages();
  let active: AbortController | null = null;
  let generation = 0;
  let disposed = false;
  let failedRequest: { offset: number; replace: boolean } | null = null;
  function publish(update: Partial<CharacterPagesState>) { state = { ...state, ...update }; onChange(state); }
  async function request(offset: number, replace: boolean) {
    if (disposed) return;
    const current = ++generation;
    active?.abort();
    const controller = new AbortController();
    active = controller;
    failedRequest = null;
    publish({ loading: true, error: '' });
    try {
      const page = await load(offset, { signal: controller.signal });
      if (disposed || current !== generation) return;
      const characters = new Map((replace ? [] : state.characters).map(character => [character.id, character]));
      for (const character of page.characters) characters.set(character.id, character);
      publish({ characters: [...characters.values()], nextOffset: page.nextOffset, loading: false });
    } catch (error) {
      if (disposed || current !== generation) return;
      failedRequest = { offset, replace };
      publish({ loading: false, error: error instanceof Error ? error.message : '角色暂时无法读取，请重试。' });
    } finally {
      if (current === generation) active = null;
    }
  }
  return {
    refresh: () => request(0, true),
    loadMore: () => state.loading || state.nextOffset === null ? Promise.resolve() : request(state.nextOffset, false),
    retry: () => state.loading || !failedRequest ? Promise.resolve() : request(failedRequest.offset, failedRequest.replace),
    dispose: () => { disposed = true; generation++; active?.abort(); active = null; },
  };
}

export async function resolveCatalogSelection(client: Pick<ApiClient, 'character'>, character: Character, signal: AbortSignal): Promise<Character> {
  if (!client.character) throw new Error('角色暂时无法读取，请刷新页面。');
  const catalogOffset = character.catalogOffset ?? 0;
  const resolved = await client.character(character.id, { signal, catalogOffset });
  // Keep the selected page through the scene builder, even for host API mocks.
  return { ...resolved, catalogOffset };
}

export function withSelectedCatalogOffset(input: CreateSessionInput, character?: Character): CreateSessionInput {
  const { catalogOffset: _unused, ...story } = input;
  return !story.worldId && character?.source === 'axon' && character.id === story.characterId
    ? { ...story, catalogOffset: character.catalogOffset ?? 0 }
    : story;
}
