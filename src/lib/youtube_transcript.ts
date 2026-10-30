/**
 * YouTube transcripts, fetched by the local helper (scripts/ai_ocr_helper.py,
 * `/video-transcript`): yt-dlp lists the caption tracks and the helper returns
 * the lines of the video's own-language track, cached per video. Or the
 * helper transcribes the audio itself with Whisper, on the user's computer.
 *
 * The earlier local proxy (yt-local-proxy.js, Innertube ANDROID client) stopped
 * working when YouTube began refusing that request. See
 * findings/VIDEO_PLAYBACK.md, "Transcripts".
 */

import { callVideoHelper } from './video_snapshot';
import { parseLocalVideoUrl } from './local_video_ref';

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
    /**
     * 'manual': captions the uploader made; 'auto': YouTube's speech
     * recognition; 'whisper': transcribed from the audio by the helper.
     */
    kind: 'manual' | 'auto' | 'whisper';
    segments: TranscriptSegment[];
}

/**
 * 'captions': the video's captions only; 'audio': Whisper on the audio, even
 * when there are captions; 'auto': the captions, else Whisper when the helper
 * has it set up.
 */
export type TranscriptSource = 'captions' | 'audio' | 'auto';

/**
 * A YouTube video's transcript. Captions come whole; Whisper transcribes only
 * `range` when given (unless the whole video's is already cached), so cut the
 * result with segmentsInRange either way. Throws with a message for the user.
 */
export async function fetchTranscript(
    videoIdOrUrl: string,
    { source = 'auto', range }: { source?: TranscriptSource; range?: { start: number; end: number } } = {}
): Promise<Transcript> {
    // A local video (local-video:// URL) has no captions: the helper always
    // transcribes its audio.
    const file = parseLocalVideoUrl(videoIdOrUrl);
    const videoId = file ? file.path : extractVideoId(videoIdOrUrl);
    if (!videoId) throw new Error(`Not a YouTube video: ${videoIdOrUrl}`);
    const transcript = await callVideoHelper<Transcript & { cached: boolean }>('/video-transcript', {
        ...(file ? { file } : { videoId }),
        source,
        ...(range ? { start: range.start, end: range.end } : {}),
    });
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
