import { EmbedBuilder } from 'discord.js';

const RAIDRIO_TIMEOUT_MS = Number(process.env.RAIDERIO_TIMEOUT_MS ?? 6000);
const RAIDRIO_RUN_CACHE_TTL_MS = Number(process.env.RAIDERIO_RUN_CACHE_TTL_MS ?? 10 * 60 * 1000); // 10m

// Group Details link example:
// https://raider.io/mythic-plus-runs/season-mn-1/13163886-15-pit-of-saron?utm_source=discord&utm_medium=notification
export const RUN_DETAILS_LINK_REGEX =
  /https:\/\/raider\.io\/mythic-plus-runs\/(?<season>[^/]+)\/(?<id>\d+)-/g;

/** @type {Map<string, { value: unknown; expiresAt: number }>} */
const runDetailsCache = new Map();

/**
 * @param {string} k
 * @returns {unknown | undefined} undefined => not cached/expired
 */
function cacheGet(k) {
  const hit = runDetailsCache.get(k);
  if (!hit) return undefined;
  if (Date.now() >= hit.expiresAt) {
    runDetailsCache.delete(k);
    return undefined;
  }
  return hit.value;
}

/**
 * @param {string} k
 * @param {unknown} value
 */
function cacheSet(k, value) {
  // Simple size guard to avoid unbounded growth.
  if (runDetailsCache.size > 10_000) runDetailsCache.clear();
  runDetailsCache.set(k, { value, expiresAt: Date.now() + RAIDRIO_RUN_CACHE_TTL_MS });
}

/**
 * @param {string | null | undefined} description
 * @returns {{ season: string; id: string } | null}
 */
export function parseRunFromDescription(description) {
  if (!description) return null;
  const re = new RegExp(RUN_DETAILS_LINK_REGEX.source, 'g');
  const m = re.exec(description);
  const season = m?.groups?.season;
  const id = m?.groups?.id;
  if (!season || !id) return null;
  return { season, id };
}

/**
 * @param {string} season
 * @param {string} id
 * @returns {Promise<unknown | null>}
 */
export async function fetchRunDetails(season, id) {
  const cacheKey = `${season}\0${id}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  const url = new URL('https://raider.io/api/v1/mythic-plus/run-details');
  url.searchParams.set('season', season);
  url.searchParams.set('id', id);
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), RAIDRIO_TIMEOUT_MS);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) {
      cacheSet(cacheKey, null);
      return null;
    }
    const body = await res.json();
    cacheSet(cacheKey, body);
    return body;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[raider.io]', msg);
    cacheSet(cacheKey, null);
    return null;
  }
}

/**
 * @param {unknown} body
 * @returns {{ name: string; guildName: string | null }[]}
 */
export function rosterFromRunDetails(body) {
  if (!body || typeof body !== 'object') return [];
  // Expected shape: { roster: [{ character: { name, guild?: { name } }}, ...] }
  const roster = /** @type {{ roster?: unknown }} */ (body).roster;
  if (!Array.isArray(roster)) return [];

  /** @type {{ name: string; guildName: string | null }[]} */
  const out = [];
  for (const entry of roster) {
    if (!entry || typeof entry !== 'object') continue;
    const character = /** @type {{ character?: unknown }} */ (entry).character;
    if (!character || typeof character !== 'object') continue;
    const name = /** @type {{ name?: unknown }} */ (character).name;
    // run-details commonly returns guild on the roster entry itself (entry.guild),
    // but some shapes may also include character.guild.
    const entryGuild = /** @type {{ guild?: unknown }} */ (entry).guild;
    const characterGuild = /** @type {{ guild?: unknown }} */ (character).guild;
    const rawGuild =
      entryGuild && typeof entryGuild === 'object'
        ? entryGuild
        : (characterGuild && typeof characterGuild === 'object' ? characterGuild : null);
    const guildName =
      rawGuild && typeof rawGuild === 'object'
        ? /** @type {{ name?: unknown }} */ (rawGuild).name
        : undefined;

    if (typeof name !== 'string' || !name) continue;
    out.push({ name, guildName: typeof guildName === 'string' && guildName ? guildName : null });
  }
  return out;
}

/**
 * @param {RegExp} cyrillicRe
 * @param {{ name: string; guildName: string | null }[]} roster
 */
export function runHasCyrillic(cyrillicRe, roster) {
  for (const p of roster) {
    if (cyrillicRe.test(p.name)) return true;
    if (p.guildName && cyrillicRe.test(p.guildName)) return true;
  }
  return false;
}

/**
 * @param {string} wowGuildName
 * @param {{ name: string; guildName: string | null }[]} roster
 * @returns {string[]}
 */
export function trackedMembersInRoster(wowGuildName, roster) {
  if (!wowGuildName) return [];
  const names = [];
  for (const p of roster) {
    if (p.guildName === wowGuildName) names.push(p.name);
  }
  return names;
}

/**
 * @param {import('discord.js').Embed} embed
 */
export function embedFromMessageEmbed(embed) {
  return EmbedBuilder.from(embed.data);
}
