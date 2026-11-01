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
