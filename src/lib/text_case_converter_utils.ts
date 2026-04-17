//Text Case Converter Utils

// forked from https://github.com/hitsu3r/remnote-text-case-converter and improved

import {
    RICH_TEXT_ELEMENT_TYPE,
} from '@remnote/plugin-sdk';

// ─── Minor words ─────────────────────────────────────────────────────────────
// Articles, prepositions and conjunctions that stay lowercase in Title Case
// unless they are the first or last word (Chicago / APA style).

const MINOR_WORDS = new Set([
    // English — articles
    'a', 'an', 'the',
    // English — coordinating conjunctions
    'and', 'or', 'nor', 'but', 'for', 'yet', 'so',
    // English — short prepositions
    'at', 'by', 'in', 'of', 'on', 'to', 'up', 'as', 'via',
    // Portuguese — articles
    'o', 'os', 'um', 'uns', 'uma', 'umas',
    // Portuguese — contractions (de + article)
    'do', 'da', 'dos', 'das',
    // Portuguese — contractions (em + article)
    'no', 'na', 'nos', 'nas',
    // Portuguese — contractions (a + artigo)
    'ao', 'aos',
    // Portuguese — contractions (por + article)
    'pelo', 'pela', 'pelos', 'pelas',
    // Portuguese — prepositions
    'de', 'em', 'por', 'para', 'com', 'sem', 'sob', 'sobre',
    // Portuguese — conjunctions
    'e', 'ou', 'mas', 'nem', 'que', 'se', 'como', 'pois', 'logo',
]);

// Unicode-aware letter test (handles accented chars, ligatures, etc.)
const LETTER_RE = /\p{L}/u;

// ─── Helpers ────────────────────────────────────────────────────────────────

export function transformCase(richText: any[], fn: (s: string) => string): any[] {
    return richText.map((element) => {
        if (typeof element === 'string') return fn(element);
        if (element?.i === RICH_TEXT_ELEMENT_TYPE.TEXT && typeof element.text === 'string') {
            return { ...element, text: fn(element.text) };
        }
        return element;
    });
}

type CaseState = 'lower' | 'title' | 'upper';

export function detectCase(text: string): CaseState {
    const letters = [...text].filter(
        (c) => LETTER_RE.test(c) && (c !== c.toUpperCase() || c !== c.toLowerCase())
    );
    if (letters.length === 0) return 'lower';

    const allUpper = letters.every((c) => c === c.toUpperCase() && c !== c.toLowerCase());
    if (allUpper) return 'upper';

    const allLower = letters.every((c) => c === c.toLowerCase() && c !== c.toUpperCase());
    if (allLower) return 'lower';

    // Smart Title Case detection — mirrors buildTitleCaseMap rules:
    //   · first and last word must have an uppercase first letter, rest lowercase
    //   · minor words in non-terminal positions may be entirely lowercase
    //   · all other words must have an uppercase first letter, rest lowercase
    const wordMatches: RegExpExecArray[] = [];
    const wordRegex = /\S+/g;
    let m;
    while ((m = wordRegex.exec(text)) !== null) wordMatches.push(m);

    const isTitle = wordMatches.every((match, idx) => {
        const raw = match[0];
        const wordLetters = [...raw].filter((c) => LETTER_RE.test(c));
        if (wordLetters.length === 0) return true;

        const isFirst = idx === 0;
        const isLast = idx === wordMatches.length - 1;
        const key = raw.toLowerCase().replace(/[^\p{L}]/gu, '');
        const isMinor = !isFirst && !isLast && MINOR_WORDS.has(key);

        if (isMinor) {
            // Minor word in non-terminal position: must be all lowercase
            return wordLetters.every((c) => c === c.toLowerCase() && c !== c.toUpperCase());
        }
        // Non-minor word: first letter uppercase, rest lowercase
        return (
            wordLetters[0] === wordLetters[0].toUpperCase() &&
            wordLetters[0] !== wordLetters[0].toLowerCase() &&
            wordLetters.slice(1).every((c) => c === c.toLowerCase())
        );
    });

    return isTitle ? 'title' : 'lower';
}

export function nextCase(current: CaseState): CaseState {
    if (current === 'lower') return 'title';
    if (current === 'title') return 'upper';
    return 'lower';
}

/**
 * Builds a boolean array over the flat fullText string.
 * map[i] === true means: the character at position i should be uppercase.
 * All other letters default to lowercase (map[i] === false).
 *
 * Rules (Chicago-style):
 *  - First and last words are always capitalised.
 *  - Words in MINOR_WORDS are kept lowercase otherwise.
 *  - For each word that should be capitalised, only its first letter is marked.
 */
function buildTitleCaseMap(fullText: string): boolean[] {
    const map: boolean[] = new Array(fullText.length).fill(false);

    const wordRegex = /\S+/g;
    let match;
    const words: { start: number; end: number; raw: string }[] = [];
    while ((match = wordRegex.exec(fullText)) !== null) {
        words.push({ start: match.index, end: match.index + match[0].length, raw: match[0] });
    }

    words.forEach(({ start, end, raw }, idx) => {
        const isFirst = idx === 0;
        const isLast = idx === words.length - 1;
        // Strip surrounding punctuation for lookup (handles "or,", "(the", etc.)
        const key = raw.toLowerCase().replace(/[^\p{L}]/gu, '');
        const shouldCapitalize = isFirst || isLast || !MINOR_WORDS.has(key);

        if (shouldCapitalize) {
            // Mark the first letter in this word's range
            for (let i = start; i < end; i++) {
                if (LETTER_RE.test(fullText[i])) {
                    map[i] = true;
                    break;
                }
            }
        }
    });

    return map;
}

/**
 * Applies smart Title Case to a rich text array.
 *
 * Uses a precomputed character-level map so that:
 *  1. Word boundaries are respected across element boundaries
 *     (e.g. "**p**ouco" stays "**P**ouco", not "**P**Ouco").
 *  2. Articles / prepositions / conjunctions (EN + PT) stay lowercase.
 *  3. Non-text elements (references, images, clozes) are left untouched
 *     and their character contribution is correctly accounted for.
 */
export function transformTitleCase(richText: any[], fullText: string): any[] {
    const map = buildTitleCaseMap(fullText);
    let charIndex = 0;

    return richText.map((element) => {
        const applyToString = (s: string): string => {
            let result = '';
            for (const c of s) {
                if (LETTER_RE.test(c)) {
                    result += map[charIndex] ? c.toUpperCase() : c.toLowerCase();
                } else {
                    result += c;
                }
                charIndex++;
            }
            return result;
        };

        if (typeof element === 'string') return applyToString(element);

        if (element?.i === RICH_TEXT_ELEMENT_TYPE.TEXT && typeof element.text === 'string') {
            return { ...element, text: applyToString(element.text) };
        }

        // For other element types (Rem references, clozes, etc.) that have a .text
        // property: advance charIndex to stay in sync with fullText, but don't modify.
        if (typeof element?.text === 'string') {
            charIndex += element.text.length;
        }
        return element;
    });
}