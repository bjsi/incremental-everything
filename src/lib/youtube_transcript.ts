/**
 * YouTube Transcript Utility
 *
 * Fetches captions via a Cloudflare Worker that handles everything:
 * - Innertube API (ANDROID client) to get caption track info
 * - Fetches and parses captions server-side (json3/srv1 formats)
 * - Returns clean segments to the client
 *
 * Deploy your own worker: see /yt-transcript-proxy/
 */

const PROXY_URL = 'http://localhost:3456';

const RE_YOUTUBE =
    /(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?/\s]{11})/i;

export interface TranscriptSegment {
    text: string;
    offset: number;
    duration: number;
}

export function extractVideoId(videoIdOrUrl: string): string | null {
    if (/^[a-zA-Z0-9_-]{11}$/.test(videoIdOrUrl)) return videoIdOrUrl;
    return videoIdOrUrl.match(RE_YOUTUBE)?.[1] ?? null;
}

/**
 * Fetch the full transcript for a YouTube video.
 * The Worker handles all the heavy lifting (Innertube API + caption parsing).
 */
export async function fetchTranscript(
    videoIdOrUrl: string,
    lang?: string
): Promise<TranscriptSegment[]> {
    const videoId = extractVideoId(videoIdOrUrl);
    if (!videoId) throw new Error(`Could not extract video ID from: ${videoIdOrUrl}`);

    console.log('[YT-Transcript] Fetching transcript for:', videoId);

    const params = new URLSearchParams({ v: videoId });
    if (lang) params.set('lang', lang);

    const url = `${PROXY_URL}/transcript?${params}`;
    console.log('[YT-Transcript] Calling Worker:', url);

    const response = await fetch(url);
    const data = await response.json();

    if (data.error) {
        console.warn('[YT-Transcript] Worker error:', data);
        throw new Error(`[YT-Transcript] ${data.error}: ${data.message}`);
    }

    if (!data.ok || !Array.isArray(data.segments)) {
        console.warn('[YT-Transcript] Unexpected response:', data);
        throw new Error('[YT-Transcript] Unexpected Worker response');
    }

    console.log('[YT-Transcript] Got', data.segments.length, 'segments for:',
        data.language, `(${data.kind})`,
        '| Available:', data.availableTracks?.map((t: any) => t.lang).join(', '));

    return data.segments;
}

/** Fetch transcript segments overlapping a time range. */
export async function getTranscriptForRange(
    videoIdOrUrl: string,
    startTime: number,
    endTime: number,
    lang?: string
): Promise<TranscriptSegment[]> {
    const all = await fetchTranscript(videoIdOrUrl, lang);
    const filtered = all.filter((s: TranscriptSegment) =>
        (s.offset + s.duration) > startTime && s.offset < endTime
    );
    console.log(`[YT-Transcript] Filtered ${filtered.length}/${all.length} for [${startTime.toFixed(1)}-${endTime.toFixed(1)}]`);
    return filtered;
}

/** Get transcript text for a range as a joined string. */
export async function getTranscriptTextForRange(
    videoIdOrUrl: string,
    startTime: number,
    endTime: number,
    lang?: string
): Promise<string> {
    const segs = await getTranscriptForRange(videoIdOrUrl, startTime, endTime, lang);
    return segs.map(s => s.text).join(' ');
}
