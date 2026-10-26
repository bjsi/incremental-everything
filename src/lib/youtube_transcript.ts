/**
 * YouTube transcripts, fetched by the local helper (scripts/ai_ocr_helper.py,
 * `/video-transcript`): yt-dlp lists the caption tracks and the helper returns
 * the lines of the video's own-language track, cached per video.
 *
 * The earlier local proxy (yt-local-proxy.js, Innertube ANDROID client) stopped
 * working when YouTube began refusing that request. See
 * findings/VIDEO_PLAYBACK.md, "Transcripts".
 */

import { callVideoHelper } from './video_snapshot';

const RE_YOUTUBE =
    /(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?|shorts|live)\/|.*[?&]v=)|youtu\.be\/)([^"&?/\s]{11})/i;

export interface TranscriptSegment {
    text: string;
    offset: number;
    duration: number;
}

export function extractVideoId(videoIdOrUrl: string): string | null {
    if (/^[a-zA-Z0-9_-]{11}$/.test(videoIdOrUrl)) return videoIdOrUrl;
    return videoIdOrUrl.match(RE_YOUTUBE)?.[1] ?? null;
}

export interface Transcript {
    language: string;
    /** 'manual': captions the uploader made; 'auto': YouTube's speech recognition. */
    kind: 'manual' | 'auto';
    segments: TranscriptSegment[];
}

/** The whole transcript of a YouTube video. Throws with a message for the user. */
export async function fetchTranscript(videoIdOrUrl: string): Promise<Transcript> {
    const videoId = extractVideoId(videoIdOrUrl);
    if (!videoId) throw new Error(`Not a YouTube video: ${videoIdOrUrl}`);
    const transcript = await callVideoHelper<Transcript & { cached: boolean }>('/video-transcript', { videoId });
    console.log(
        `[YT-Transcript] ${videoId}: ${transcript.segments.length} lines, ${transcript.language} (${transcript.kind})` +
            (transcript.cached ? ', cached' : '')
    );
    return transcript;
}

/** The lines overlapping a time range, in seconds. */
export function segmentsInRange(segments: TranscriptSegment[], startTime: number, endTime: number) {
    return segments.filter((s) => s.offset + s.duration > startTime && s.offset < endTime);
}
