// Reduces a URL to the page it names, so that two addresses of one web page
// compare equal. RemNote gives each distinct URL string its own Link Rem (see
// findings/REM_REFERENCES_AND_MERGE.md), so comparing Link Rem ids would miss
// `#section`, `www.`, http/https and tracking-parameter variants.

const TRACKING_PARAM = /^(utm_.+|fbclid|gclid|dclid|msclkid|yclid|mc_cid|mc_eid|igshid|_hsenc|_hsmi|ref_src)$/i;

const YOUTUBE_HOST = /^((www|m|music)\.)?youtube\.com$/;
const YOUTUBE_ID_PATH = /^\/(embed|shorts|live|v)\/([^/]+)/;

function youTubeKey(url: URL): string | null {
  if (url.hostname === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    return id ? `youtube.com/watch?v=${id}` : null;
  }
  if (!YOUTUBE_HOST.test(url.hostname)) return null;
  const id = url.searchParams.get('v') ?? url.pathname.match(YOUTUBE_ID_PATH)?.[2];
  return id ? `youtube.com/watch?v=${id}` : null;
}

/**
 * The comparison key of a URL, or null for what names no page on its own: an
 * empty string, or a relative link such as `/docs` or `#fn:1`.
 *
 * Path case is kept, since paths are case-sensitive on most servers. A fragment
 * is dropped unless it is a hash route (`#/inbox`, `#!/post/1`), where it is the
 * page. Other schemes (`file:`, `x-devonthink-item:`) compare as written.
 */
export function canonicalUrlKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return text;

  const youTube = youTubeKey(url);
  if (youTube) return youTube;

  const host = url.host.replace(/^www\./, '');
  const path = url.pathname.replace(/\/+$/, '');
  const params = [...url.searchParams.entries()]
    .filter(([name]) => !TRACKING_PARAM.test(name))
    .map(([name, value]) => `${name}=${value}`)
    .sort();
  const query = params.length ? `?${params.join('&')}` : '';
  const route = /^#[/!]/.test(url.hash) ? url.hash : '';
  return `${host}${path}${query}${route}`;
}

/** Second-level names under which each registrant gets a third: `folha.uol.com.br` is under `uol.com.br`. */
const COUNTRY_SECOND_LEVEL = new Set(['ac', 'co', 'com', 'edu', 'gov', 'mil', 'ne', 'net', 'or', 'org']);
/** Hosts whose subdomains are unrelated sites. */
const SHARED_HOSTS = ['github.io', 'substack.com', 'medium.com', 'wordpress.com', 'blogspot.com', 'notion.site'];

/**
 * The website a page key belongs to, for grouping: `en.wikipedia.org/wiki/X` and
 * `pt.wikipedia.org/wiki/Y` are both `wikipedia.org`. This is a heuristic rather
 * than the full public-suffix list, which is too large to ship for a label. Keys
 * of other schemes group by scheme (`file:`).
 */
export function domainOfPageKey(key: string): string {
  const scheme = key.match(/^[a-z][a-z0-9+.-]*:(?!\d)/i);
  if (scheme) return scheme[0].toLowerCase();

  const host = key.split(/[/?#]/)[0].replace(/:\d+$/, '');
  const labels = host.split('.');
  if (labels.length <= 2 || /^[\d.]+$/.test(host) || host.includes(':')) return host;

  const lastTwo = labels.slice(-2).join('.');
  const [secondLevel, topLevel] = labels.slice(-2);
  const keepThree =
    SHARED_HOSTS.includes(lastTwo) || (topLevel.length === 2 && COUNTRY_SECOND_LEVEL.has(secondLevel));
  return keepThree ? labels.slice(-3).join('.') : lastTwo;
}
