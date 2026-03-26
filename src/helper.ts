import { EmbedBuilder, type Embed } from 'discord.js';

/** Match Ruby: https://raider.io/characters/eu/(realm)/(name)?... */
export const PLAYER_REGEX =
  /https:\/\/raider\.io\/characters\/eu\/(?<realm>.+)\/(?<name>.+)\?/g;

const CYRILLIC_REGEX = /[а-яА-Я]/;

export type RealmNamePair = [realm: string, playerName: string];

export function namesAndRealms(description: string | null | undefined): RealmNamePair[] {
  if (!description) return [];
  const out: RealmNamePair[] = [];
  const re = new RegExp(PLAYER_REGEX.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(description)) !== null) {
    const realm = m.groups?.realm;
    const name = m.groups?.name;
    if (realm && name) out.push([realm, name]);
  }
  return out;
}

export async function fetchWowGuildName(realm: string, playerName: string): Promise<string | null> {
  const url = new URL('https://raider.io/api/v1/characters/profile');
  url.searchParams.set('region', 'eu');
  url.searchParams.set('realm', realm);
  url.searchParams.set('name', playerName);
  url.searchParams.set('fields', 'guild');
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = (await res.json()) as { guild?: { name?: string } | null };
    return body.guild?.name ?? null;
  } catch (e) {
    console.error('[raider.io]', (e as Error).message);
    return null;
  }
}

/** True when detection should run: Cyrillic somewhere + a Cyrillic-named player whose guild is not whitelisted. */
export async function russianInGroup(
  whitelistedGuildNames: string[],
  description: string | null | undefined,
): Promise<boolean> {
  if (!description || !CYRILLIC_REGEX.test(description)) return false;

  for (const [realm, playerName] of namesAndRealms(description)) {
    if (!CYRILLIC_REGEX.test(playerName)) continue;
    const guild = await fetchWowGuildName(realm, playerName);
    if (!guild) continue;
    if (!whitelistedGuildNames.includes(guild)) return true;
  }
  return false;
}

export async function suspects(
  description: string | null | undefined,
  configuredWowGuildName: string | null | undefined,
): Promise<string[]> {
  if (!configuredWowGuildName) return [];
  const names: string[] = [];
  for (const [realm, playerName] of namesAndRealms(description)) {
    try {
      const guild = await fetchWowGuildName(realm, playerName);
      if (guild === configuredWowGuildName) names.push(playerName);
    } catch (e) {
      console.error('[raider.io]', (e as Error).message);
    }
  }
  return names;
}

export function embedFromMessageEmbed(embed: Embed): EmbedBuilder {
  return EmbedBuilder.from(embed.data);
}
