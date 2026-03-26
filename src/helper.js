import { EmbedBuilder } from 'discord.js';

/** Match Ruby: https://raider.io/characters/eu/(realm)/(name)?... */
export const PLAYER_REGEX =
  /https:\/\/raider\.io\/characters\/eu\/(?<realm>.+)\/(?<name>.+)\?/g;

const CYRILLIC_REGEX = /[а-яА-Я]/;

export function pairKey(realm, playerName) {
  return `${realm}\0${playerName}`;
}

/**
 * @param {string | null | undefined} description
 * @returns {[string, string][]}
 */
export function namesAndRealms(description) {
  if (!description) return [];
  const out = [];
  const re = new RegExp(PLAYER_REGEX.source, 'g');
  let m;
  while ((m = re.exec(description)) !== null) {
    const realm = m.groups?.realm;
    const name = m.groups?.name;
    if (realm && name) out.push([realm, name]);
  }
  return out;
}

/**
 * @param {string} realm
 * @param {string} playerName
 * @returns {Promise<string | null>}
 */
export async function fetchWowGuildName(realm, playerName) {
  const url = new URL('https://raider.io/api/v1/characters/profile');
  url.searchParams.set('region', 'eu');
  url.searchParams.set('realm', realm);
  url.searchParams.set('name', playerName);
  url.searchParams.set('fields', 'guild');
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = await res.json();
    return body.guild?.name ?? null;
  } catch (e) {
    console.error('[raider.io]', /** @type {Error} */ (e).message);
    return null;
  }
}

/**
 * Fetch guild for each unique (realm, name) in pairs; skips keys already in guildByPair.
 * @param {[string, string][]} pairs
 * @param {Map<string, string | null>} guildByPair
 */
export async function ensureGuildsResolved(pairs, guildByPair) {
  const pending = [];
  const seen = new Set();
  for (const [realm, name] of pairs) {
    const k = pairKey(realm, name);
    if (seen.has(k)) continue;
    seen.add(k);
    if (guildByPair.has(k)) continue;
    pending.push([realm, name, k]);
  }
  await Promise.all(
    pending.map(async ([realm, name, k]) => {
      const g = await fetchWowGuildName(realm, name);
      guildByPair.set(k, g);
    }),
  );
}

/**
 * @param {string | null | undefined} description
 * @param {string[]} whitelistedGuildNames
 * @param {[string, string][]} pairs
 * @param {Map<string, string | null>} guildByPair
 */
export function shouldAlertForCyrillicUnwhitelisted(description, whitelistedGuildNames, pairs, guildByPair) {
  if (!description || !CYRILLIC_REGEX.test(description)) return false;
  for (const [realm, playerName] of pairs) {
    if (!CYRILLIC_REGEX.test(playerName)) continue;
    const guild = guildByPair.get(pairKey(realm, playerName)) ?? null;
    if (!guild) continue;
    if (!whitelistedGuildNames.includes(guild)) return true;
  }
  return false;
}

/**
 * @param {string | null | undefined} wowGuildName
 * @param {[string, string][]} pairs
 * @param {Map<string, string | null>} guildByPair
 * @returns {string[]}
 */
export function suspectNamesMatchingGuild(wowGuildName, pairs, guildByPair) {
  if (!wowGuildName) return [];
  const names = [];
  for (const [realm, playerName] of pairs) {
    if (guildByPair.get(pairKey(realm, playerName)) === wowGuildName) names.push(playerName);
  }
  return names;
}

/**
 * @param {import('discord.js').Embed} embed
 */
export function embedFromMessageEmbed(embed) {
  return EmbedBuilder.from(embed.data);
}
