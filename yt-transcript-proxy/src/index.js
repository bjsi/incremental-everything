// YouTube Transcript CORS Proxy — Cloudflare Worker
//
// Smart endpoint:
//   GET /transcript?v=<videoId>&lang=en
//
// Uses YouTube's Innertube API (POST, returns clean JSON) to get
// caption track URLs, then fetches the actual caption XML.
// Both requests happen in one Worker invocation.
//
// Deploy: cd yt-transcript-proxy && npx wrangler deploy

const UA_BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const UA_ANDROID = 'com.google.android.youtube/19.02.39 (Linux; U; Android 14)';

// Innertube client context — ANDROID client works reliably (WEB returns UNPLAYABLE)
const INNERTUBE_CONTEXT = {
    client: {
        clientName: 'ANDROID',
        clientVersion: '19.02.39',
        androidSdkVersion: 34,
        hl: 'en',
        gl: 'US',
    },
};

export default {
    async fetch(request) {
        if (request.method === 'OPTIONS') {
            return corsResponse(null, 204);
        }

        const url = new URL(request.url);

        if (url.pathname === '/transcript') {
            return handleTranscript(url.searchParams);
        }

        // Generic proxy fallback
        const targetUrl = url.searchParams.get('url');
        if (targetUrl) {
            return handleProxy(targetUrl);
        }

        return corsResponse(JSON.stringify({ error: 'Use /transcript?v=VIDEO_ID' }), 400);
    },
};

async function handleTranscript(params) {
    const videoId = params.get('v');
    const preferLang = params.get('lang') || 'en';

    if (!videoId) {
        return corsResponse(JSON.stringify({ error: 'Missing ?v= parameter' }), 400);
    }

    try {
        // Step 1: Use Innertube API to get caption track URLs
        // This is a POST endpoint that returns clean JSON — much more reliable
        // than scraping YouTube's HTML page.
        const playerResp = await fetch(
            'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': UA_ANDROID,
                },
                body: JSON.stringify({
                    context: INNERTUBE_CONTEXT,
                    videoId: videoId,
                }),
            }
        );

        if (!playerResp.ok) {
            return corsResponse(JSON.stringify({
                error: 'innertube_error',
                message: `Innertube API returned HTTP ${playerResp.status}`,
            }), 200);
        }

        const playerData = await playerResp.json();

        // Step 2: Extract caption tracks
        const captionTracks =
            playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

        if (!captionTracks || captionTracks.length === 0) {
            return corsResponse(JSON.stringify({
                error: 'no_captions',
                message: 'No captions available for this video',
                debug: {
                    hasPlayability: !!playerData?.playabilityStatus,
                    playabilityStatus: playerData?.playabilityStatus?.status,
                    hasCaptions: !!playerData?.captions,
                },
            }), 200);
        }

        // Step 3: Select best track
        const track =
            captionTracks.find(t => t.languageCode === preferLang) ||
            captionTracks[0];

        // Step 4: Fetch captions
        // Build a clean URL — strip IP-bound params (ip=0.0.0.0 from CF Workers)
        const baseUrlObj = new URL(track.baseUrl);
        const cleanParams = new URLSearchParams();
        for (const key of ['v', 'ei', 'lang', 'name', 'kind', 'caps', 'opi', 'xoaf']) {
            if (baseUrlObj.searchParams.has(key)) {
                cleanParams.set(key, baseUrlObj.searchParams.get(key));
            }
        }

        // Try json3 first (easiest to parse), then srv1 as fallback
        let segments = [];

        // Attempt 1: json3
        cleanParams.set('fmt', 'json3');
        const json3Url = `https://www.youtube.com/api/timedtext?${cleanParams.toString()}`;
        try {
            const resp = await fetch(json3Url, { headers: { 'User-Agent': UA_BROWSER } });
            const data = await resp.json();
            if (Array.isArray(data?.events)) {
                for (const ev of data.events) {
                    if (!ev.segs) continue;
                    const text = ev.segs.map(s => s.utf8 || '').join('').trim();
                    if (text) {
                        segments.push({
                            offset: (ev.tStartMs || 0) / 1000,
                            duration: (ev.dDurationMs || 0) / 1000,
                            text,
                        });
                    }
                }
            }
        } catch { /* try next format */ }

        // Attempt 2: srv1 XML (if json3 returned no segments)
        if (segments.length === 0) {
            cleanParams.set('fmt', 'srv1');
            const srv1Url = `https://www.youtube.com/api/timedtext?${cleanParams.toString()}`;
            try {
                const resp = await fetch(srv1Url, { headers: { 'User-Agent': UA_BROWSER } });
                const xml = await resp.text();
                const re = /<text start="([^"]*)" dur="([^"]*)"[^>]*>([^<]*)<\/text>/g;
                let m;
                while ((m = re.exec(xml)) !== null) {
                    segments.push({
                        offset: parseFloat(m[1]),
                        duration: parseFloat(m[2]),
                        text: m[3].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim(),
                    });
                }
            } catch { /* try next */ }
        }

        // Attempt 3: full baseUrl with original params (last resort)
        if (segments.length === 0) {
            let fullUrl = track.baseUrl;
            if (!fullUrl.includes('fmt=')) fullUrl += '&fmt=json3';
            try {
                const resp = await fetch(fullUrl, { headers: { 'User-Agent': UA_BROWSER } });
                const data = await resp.json();
                if (Array.isArray(data?.events)) {
                    for (const ev of data.events) {
                        if (!ev.segs) continue;
                        const text = ev.segs.map(s => s.utf8 || '').join('').trim();
                        if (text) {
                            segments.push({
                                offset: (ev.tStartMs || 0) / 1000,
                                duration: (ev.dDurationMs || 0) / 1000,
                                text,
                            });
                        }
                    }
                }
            } catch { /* all attempts exhausted */ }
        }

        return corsResponse(JSON.stringify({
            ok: true,
            language: track.languageCode,
            kind: track.kind || 'manual',
            availableTracks: captionTracks.map(t => ({
                lang: t.languageCode,
                kind: t.kind || 'manual',
                name: t.name?.simpleText || '',
            })),
            segments,
        }), 200, 'application/json');

    } catch (err) {
        return corsResponse(JSON.stringify({
            error: 'fetch_error',
            message: err.message,
        }), 502);
    }
}

async function handleProxy(targetUrl) {
    try {
        const parsed = new URL(targetUrl);
        if (!parsed.hostname.endsWith('youtube.com') && !parsed.hostname.endsWith('youtu.be')) {
            return corsResponse(JSON.stringify({ error: 'Only YouTube URLs allowed' }), 403);
        }
    } catch {
        return corsResponse(JSON.stringify({ error: 'Invalid URL' }), 400);
    }

    try {
        const response = await fetch(targetUrl, {
            headers: { 'User-Agent': UA_BROWSER },
        });
        const body = await response.text();
        return corsResponse(body, response.status, response.headers.get('Content-Type') || 'text/plain');
    } catch (err) {
        return corsResponse(JSON.stringify({ error: err.message }), 502);
    }
}

function corsResponse(body, status = 200, contentType = 'application/json') {
    return new Response(body, {
        status,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Content-Type': contentType,
        },
    });
}
