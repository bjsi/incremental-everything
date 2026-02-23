#!/usr/bin/env node
/**
 * Local YouTube Transcript Proxy
 *
 * Runs on your machine using your residential IP (not blocked by YouTube).
 * The RemNote plugin calls http://localhost:3456/transcript?v=VIDEO_ID
 *
 * Usage:  node yt-local-proxy.js
 * Stop:   Ctrl+C
 */

const http = require('http');
const https = require('https');

const PORT = 3456;
const UA_ANDROID = 'com.google.android.youtube/19.02.39 (Linux; U; Android 14)';
const UA_BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function httpsRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const reqOptions = {
            hostname: urlObj.hostname,
            port: urlObj.port || 443,
            path: urlObj.pathname + urlObj.search,
            method: options.method || 'GET',
            headers: {
                'User-Agent': options.userAgent || UA_BROWSER,
                ...options.headers,
            },
        };

        const req = https.request(reqOptions, (res) => {
            // Follow redirects
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return httpsRequest(res.headers.location, options).then(resolve, reject);
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
        if (options.body) req.write(options.body);
        req.end();
    });
}

function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json',
    };
}

function sendJson(res, status, data) {
    res.writeHead(status, corsHeaders());
    res.end(JSON.stringify(data));
}

/**
 * Parse srv3 format (YouTube's default caption format).
 * Structure: <p t="startMs" d="durationMs" w="1"><s>word1 </s><s t="offset">word2</s></p>
 */
function parseSrv3(xml) {
    const segments = [];
    // Match <p> elements with t and d attributes
    const pRegex = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
    let pMatch;
    while ((pMatch = pRegex.exec(xml)) !== null) {
        const startMs = parseInt(pMatch[1]);
        const durMs = parseInt(pMatch[2]);
        const content = pMatch[3];

        // Extract text from <s> elements or raw text
        let text = '';
        const sRegex = /<s[^>]*>([^<]*)<\/s>/g;
        let sMatch;
        while ((sMatch = sRegex.exec(content)) !== null) {
            text += sMatch[1];
        }
        // If no <s> elements, use raw content (strip tags)
        if (!text) {
            text = content.replace(/<[^>]+>/g, '');
        }
        text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n/g, ' ').trim();

        if (text) {
            segments.push({
                offset: startMs / 1000,
                duration: durMs / 1000,
                text,
            });
        }
    }
    return segments;
}

/** Parse srv1 format: <text start="sec" dur="sec">text</text> */
function parseSrv1(xml) {
    const segments = [];
    const re = /<text start="([^"]*)" dur="([^"]*)"[^>]*>([^<]*)<\/text>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
        const text = m[3].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
        if (text) {
            segments.push({ offset: parseFloat(m[1]), duration: parseFloat(m[2]), text });
        }
    }
    return segments;
}

/** Parse json3 format */
function parseJson3(body) {
    try {
        const data = JSON.parse(body);
        if (!Array.isArray(data?.events)) return [];
        const segments = [];
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
        return segments;
    } catch { return []; }
}

async function handleTranscript(videoId, preferLang, res) {
    try {
        console.log(`[Proxy] Fetching transcript for: ${videoId}`);

        // Step 1: Use Innertube API to get caption track info
        const innertubeResp = await httpsRequest(
            'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
            {
                method: 'POST',
                userAgent: UA_ANDROID,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    context: {
                        client: {
                            clientName: 'ANDROID',
                            clientVersion: '19.02.39',
                            androidSdkVersion: 34,
                            hl: 'en',
                            gl: 'US',
                        },
                    },
                    videoId,
                }),
            }
        );

        const playerData = JSON.parse(innertubeResp.body);
        const status = playerData?.playabilityStatus?.status;
        console.log(`[Proxy] Innertube status: ${status}`);

        if (status !== 'OK') {
            return sendJson(res, 200, {
                error: 'playability_error',
                message: `Video status: ${status} - ${playerData?.playabilityStatus?.reason || 'unknown'}`,
            });
        }

        const captionTracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        if (!captionTracks?.length) {
            return sendJson(res, 200, { error: 'no_captions', message: 'No captions available' });
        }

        // Step 2: Select best track
        const track = captionTracks.find(t => t.languageCode === preferLang) || captionTracks[0];
        console.log(`[Proxy] Using track: ${track.languageCode} (${track.kind || 'manual'})`);

        // Step 3: Fetch caption content using the signed baseUrl
        const captionResp = await httpsRequest(track.baseUrl, { userAgent: UA_BROWSER });
        console.log(`[Proxy] Caption response: ${captionResp.body.length} bytes`);

        // Step 4: Parse caption content (try multiple formats)
        let segments = parseSrv3(captionResp.body);
        if (segments.length === 0) segments = parseSrv1(captionResp.body);
        if (segments.length === 0) segments = parseJson3(captionResp.body);

        console.log(`[Proxy] ✅ Parsed ${segments.length} segments`);

        sendJson(res, 200, {
            ok: true,
            language: track.languageCode,
            kind: track.kind || 'manual',
            availableTracks: captionTracks.map(t => ({
                lang: t.languageCode,
                kind: t.kind || 'manual',
                name: t.name?.simpleText || '',
            })),
            segments,
        });

    } catch (err) {
        console.error(`[Proxy] Error:`, err.message);
        sendJson(res, 502, { error: 'fetch_error', message: err.message });
    }
}

const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders());
        return res.end();
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === '/transcript') {
        const videoId = url.searchParams.get('v');
        const lang = url.searchParams.get('lang') || 'en';
        if (!videoId) return sendJson(res, 400, { error: 'Missing ?v= parameter' });
        return handleTranscript(videoId, lang, res);
    }

    if (url.pathname === '/') {
        return sendJson(res, 200, { status: 'ok', message: 'YouTube Transcript Proxy running' });
    }

    sendJson(res, 404, { error: 'Use /transcript?v=VIDEO_ID' });
});

server.listen(PORT, () => {
    console.log(`\n🎬 YouTube Transcript Proxy running on http://localhost:${PORT}`);
    console.log(`   Test: http://localhost:${PORT}/transcript?v=8BXQWJ-54mc\n`);
});
