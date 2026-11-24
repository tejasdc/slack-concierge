/**
 * The houses an Inbox thread can live in. In his "Anatomy of a thread" a room is an agent space inside
 * one thread, so the larger grouping is called a house everywhere in code. Unset reads as discussions on
 * purpose: nothing he might want is hidden by default (Tejas, 2026-11-24: "The whole threats
 * functionality has to be redesigned around like rooms. So I can walk into the right room").
 */
export const THREAD_HOUSES = ['discussions', 'building', 'everyday', 'notices'] as const;
export type ThreadHouse = typeof THREAD_HOUSES[number];

export const THREAD_HOUSE_NAMES: Record<ThreadHouse, string> = {
  discussions: 'Discussions',
  building: 'Building',
  everyday: 'Everyday',
  notices: 'Notices',
};

export const isThreadHouse = (value: unknown): value is ThreadHouse =>
  typeof value === 'string' && (THREAD_HOUSES as readonly string[]).includes(value);

export const houseOf = (stored: { house?: string | null } | null | undefined): ThreadHouse =>
  isThreadHouse(stored?.house) ? stored.house : 'discussions';
