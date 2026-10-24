// Fork (ypsum): matching for the listing check. Reads name, phone, postal
// code and street from Google result titles, snippets and URL slugs and
// compares them with the business's own data.
import type { ListingSerpItem } from "@/server/lib/dataforseo/listingSerp";
import type { ListingPortal } from "@/server/features/listings/portals";

type SerpLiveItem = ListingSerpItem;

type Nap = {
  name: string;
  street: string;
  postalCode: string;
  city: string;
  phone: string;
  website?: string;
};

/** Characters around the business name that count as "its" data. */
const NEAR_NAME = 120;
/** Social posts, reels and photos are not listing entries. */
export const POST_PATH =
  /\/(?:posts|reel|reels|p|videos|photos|status|stories)\//i;

export type Field = "phone" | "postalCode" | "street";
export type Status =
  | "correct"
  | "deviating"
  | "duplicate"
  | "unverified"
  | "not_found";

export type Entry = {
  url: string;
  title: string;
  snippet: string;
  mismatches: Field[];
};

export const compact = (text: string) =>
  text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** German numbers to one digit string: +49 / 0049 prefix becomes 0. */
export function phoneDigits(text: string) {
  const digits = text.replace(/[^\d+]/g, "");
  return digits.replace(/^(\+49|0049)/, "0").replace(/\D/g, "");
}

const PHONE_PATTERN = /(?:\+49|0049|\b0)[\d\s/()-]{6,}\d/g;
const POSTAL_PATTERN = /\b\d{5}\b/g;
const STREET_PATTERN =
  /([\p{L}.-]+(?:\s?(?:straße|strasse|str\.?|weg|platz|allee|gasse|ring|damm|ufer|chaussee)))\s*(\d+\s?[a-z]?)\b/giu;

function streetKey(street: string) {
  return compact(
    street.replace(/str(?:\.|asse|aße)/giu, "strasse").replace(/\d.*$/, ""),
  );
}

export function hostOf(url: string) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function belongsTo(host: string, portal: ListingPortal) {
  return portal.domains.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}

export function normalizeUrl(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname.replace(/\/$/, "")}`.toLowerCase();
  } catch {
    return url;
  }
}

/** Title, snippet and the URL path as words (some portals put the address
 *  only into the URL slug). */
export function entryText(item: SerpLiveItem) {
  let path = "";
  try {
    path = decodeURIComponent(new URL(item.url ?? "").pathname).replace(
      /[-_/]+/g,
      " ",
    );
  } catch {
    // keep title and snippet only
  }
  return `${item.title ?? ""} · ${item.description ?? ""} · ${path}`;
}

/** Index ranges near each mention of the business name. */
function nameWindows(text: string, nap: Nap) {
  const lower = text.toLowerCase();
  const needle = nap.name.toLowerCase();
  const windows: [number, number][] = [];
  for (
    let at = lower.indexOf(needle);
    at !== -1;
    at = lower.indexOf(needle, at + 1)
  ) {
    windows.push([at - NEAR_NAME, at + needle.length + NEAR_NAME]);
  }
  return windows;
}

function nearName(windows: [number, number][], index: number) {
  return windows.some(([from, to]) => index >= from && index <= to);
}

/** The fields an entry contradicts, judged only from data shown near the
 *  business name, so another company in the same snippet does not count. */
export function compareToNap(text: string, nap: Nap) {
  const windows = nameWindows(text, nap);
  const near = (pattern: RegExp) =>
    [...text.matchAll(pattern)].filter((m) => nearName(windows, m.index));
  const mismatches: Field[] = [];
  let checked = 0;
  const phones = near(PHONE_PATTERN).map((m) => phoneDigits(m[0]));
  if (phones.length > 0) {
    checked++;
    if (!phones.includes(phoneDigits(nap.phone))) mismatches.push("phone");
  }
  const postalCodes = near(POSTAL_PATTERN).map((m) => m[0]);
  if (postalCodes.length > 0) {
    checked++;
    if (!postalCodes.includes(nap.postalCode)) mismatches.push("postalCode");
  }
  const streets = near(STREET_PATTERN).map((m) => streetKey(m[1]));
  if (streets.length > 0) {
    checked++;
    if (!streets.includes(streetKey(nap.street))) mismatches.push("street");
  }
  return { mismatches, checked };
}

export function mentionsBusiness(item: SerpLiveItem, nap: Nap) {
  const text = `${item.title ?? ""} ${item.description ?? ""} ${item.url ?? ""}`;
  return (
    compact(text).includes(compact(nap.name)) ||
    (text.match(PHONE_PATTERN) ?? [])
      .map(phoneDigits)
      .includes(phoneDigits(nap.phone))
  );
}
