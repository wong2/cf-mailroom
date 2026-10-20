export type PlainTextSegment =
  | { type: "text"; value: string }
  | { type: "link"; value: string; href: string };

const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"'“”‘’]+/gi;
const ALWAYS_TRAILING_PUNCTUATION = new Set([
  ".",
  ",",
  "!",
  "?",
  ";",
  ":",
  "。",
  "，",
  "！",
  "？",
  "；",
  "：",
  "、",
  "…",
]);
const BALANCED_CLOSERS: Record<string, string> = {
  ")": "(",
  "]": "[",
  "}": "{",
  "）": "（",
  "】": "【",
  "》": "《",
};

export function linkifyPlainText(input: string): PlainTextSegment[] {
  const segments: PlainTextSegment[] = [];
  let cursor = 0;

  for (const match of input.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    if (isPartOfEmailOrWord(input, start)) continue;

    const raw = match[0];
    const value = trimTrailingPunctuation(raw);
    if (!value || !isValidWebUrl(value)) continue;

    if (start > cursor) segments.push({ type: "text", value: input.slice(cursor, start) });
    const href = value.toLowerCase().startsWith("www.") ? `https://${value}` : value;
    const destination = unwrapGoogleRedirect(href);
    segments.push({
      type: "link",
      value: destination === href ? value : destination,
      href: destination,
    });
    cursor = start + value.length;
  }

  if (cursor < input.length) segments.push({ type: "text", value: input.slice(cursor) });
  return segments.length > 0 ? segments : [{ type: "text", value: input }];
}

// Decode only known wrappers, without fetching links or changing destination parameters.
export function unwrapGoogleRedirect(value: string): string {
  let destination = value;
  for (let depth = 0; depth < 5; depth += 1) {
    try {
      const redirect = new URL(destination);
      if (
        !["http:", "https:"].includes(redirect.protocol) ||
        !["google.com", "www.google.com"].includes(redirect.hostname) ||
        redirect.pathname !== "/url" ||
        redirect.username || redirect.password || redirect.port
      ) break;

      const target = redirect.searchParams.get("q") || redirect.searchParams.get("url");
      if (!target) break;
      const url = new URL(target);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) break;
      destination = target;
    } catch {
      break;
    }
  }
  return destination;
}

export function removeRedundantGoogleRedirects(input: string): string {
  const lines = input.split("\n");
  const visibleLines: string[] = [];

  for (const line of lines) {
    const redirectTarget = googleRedirectTarget(line.trim());
    const previous = visibleLines.at(-1)?.trim();
    if (redirectTarget && previous && sameUrl(previous, redirectTarget)) continue;
    visibleLines.push(line);
  }

  return visibleLines.join("\n");
}

function isPartOfEmailOrWord(input: string, start: number): boolean {
  if (start === 0) return false;
  return /[\p{L}\p{N}_@]/u.test(input[start - 1]);
}

function trimTrailingPunctuation(value: string): string {
  let end = value.length;
  while (end > 0) {
    const character = value[end - 1];
    if (ALWAYS_TRAILING_PUNCTUATION.has(character)) {
      end -= 1;
      continue;
    }

    const opener = BALANCED_CLOSERS[character];
    if (opener && count(value.slice(0, end), character) > count(value.slice(0, end), opener)) {
      end -= 1;
      continue;
    }
    break;
  }
  return value.slice(0, end);
}

function count(value: string, character: string): number {
  return [...value].filter((candidate) => candidate === character).length;
}

function isValidWebUrl(value: string): boolean {
  try {
    const candidate = new URL(value.toLowerCase().startsWith("www.") ? `https://${value}` : value);
    return candidate.protocol === "http:" || candidate.protocol === "https:";
  } catch {
    return false;
  }
}

function googleRedirectTarget(value: string): string | null {
  const match = value.match(/^<([^<>]+)>$/);
  if (!match) return null;

  const candidate = /^www\./i.test(match[1]) ? `https://${match[1]}` : match[1];
  const destination = unwrapGoogleRedirect(candidate);
  return destination === candidate ? null : destination;
}

function sameUrl(left: string, right: string): boolean {
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return false;
  }
}
