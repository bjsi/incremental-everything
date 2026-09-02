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
    'ao', 'aos', 'à', 'às',
    // Portuguese — contractions (por + article)
    'pelo', 'pela', 'pelos', 'pelas',
    // Portuguese — prepositions
    'de', 'em', 'por', 'para', 'com', 'sem', 'sob', 'sobre',
    // Portuguese — conjunctions
    'e', 'ou', 'mas', 'nem', 'que', 'se', 'como', 'pois', 'logo',
]);

// Unicode-aware letter test (handles accented chars, ligatures, etc.)
const LETTER_RE = /\p{L}/u;

// ─── Acronyms / initialisms ──────────────────────────────────────────────────
// Words that are uppercase by nature and must survive Title Case intact:
// "arqueação bruta (ab)" → "Arqueação Bruta (AB)", never "(Ab)".
//
// Four signals, checked in this order:
//   1. The acronym list — BUILT_IN_ACRONYMS plus whatever the user added under
//      Settings → Other → "Title Case Acronyms". This is the only signal that
//      survives a round trip through lowercase, so domain terms belong here.
//   2. Dotted initialisms ("u.s.a.", "e.u.") and single initials ("A. Silva"),
//      minus the handful of dotted abbreviations that are conventionally
//      lowercase ("e.g.", "i.e.").
//   3. Roman numerals used as numbers ("Seção II", "Capítulo V") — see the
//      note above ROMAN_RE for what counts as being used as a number.
//   4. Caps already present in the source: a run of 2+ uppercase letters inside
//      text that is NOT entirely uppercase is taken at its word and preserved.
//      Switched off for all-caps input, where existing caps say nothing.
//
// A trailing lowercase plural "s" stays lowercase ("GTs", not "GTS").
//
// The list wins over MINOR_WORDS, so an entry like "SE" would capitalise every
// Portuguese "se". Two-letter entries deserve that much thought.

const BUILT_IN_ACRONYMS = new Set([
    // Maritime / shipping
    'GT', 'NT', 'GRT', 'NRT', 'DWT', 'TPB', 'AB', 'LOA', 'TEU', 'FEU',
    'IMO', 'MMSI', 'AIS', 'ECDIS', 'GMDSS', 'EPIRB', 'SART', 'VHF', 'MF', 'HF',
    'SOLAS', 'MARPOL', 'STCW', 'COLREG', 'COLREGS', 'UNCLOS', 'ISM', 'ISPS',
    'MLC', 'PSC', 'SAR', 'OOW', 'ETA', 'ETD',
    'LNG', 'LPG', 'VLCC', 'ULCC', 'FPSO', 'ROV', 'AUV',
    'IALA', 'IHO', 'ILO', 'ITF', 'USCG', 'ANTAQ', 'DPC', 'NORMAM', 'VDR',
    // Institutional / geographic. Note the absences: "EU" would capitalise every
    // Portuguese "eu", as "MOB" and "RAM" would every "mob" and "ram". Entries
    // that collide with a real word belong in the user's own list, not here.
    'UN', 'UK', 'USA', 'EUA', 'ONU', 'NASA', 'NATO', 'OTAN',
    'CPF', 'CNPJ', 'CEP', 'IBGE', 'INSS',
    'ISO', 'IEC', 'IEEE', 'ANSI', 'GMT', 'UTC',
    // Technical
    'API', 'ASCII', 'CPU', 'GPU', 'CSS', 'CSV', 'DNS', 'DOI', 'DPI',
    'FAQ', 'GPS', 'HTML', 'HTTP', 'HTTPS', 'JSON', 'JPG', 'OCR', 'PDF', 'PNG',
    'RGB', 'SQL', 'SVG', 'URL', 'USB', 'UUID', 'XML', 'YAML',
]);

/** Dotted abbreviations that stay lowercase despite looking like initialisms. */
const LOWERCASE_DOTTED = new Set(['e.g.', 'i.e.', 'a.m.', 'p.m.', 'p.ex.', 'cf.']);

// A word already written in caps: uppercase letters and digits, optionally
// joined by "-", "." "/" or "&" ("MARPOL", "RO-RO", "A/S", "P&I"), with
// surrounding punctuation and a trailing plural "s" allowed. Two uppercase
// letters are the minimum (counted separately), so "500" and the initial "A."
// are not acronyms.
const UPPER_RUN_RE =
    /^[^\p{L}\p{N}]*(?:\p{Lu}|\p{N})+(?:[-./&](?:\p{Lu}|\p{N})+)*s?[^\p{L}\p{N}]*$/u;
const UPPERCASE_LETTER_RE = /\p{Lu}/gu;
const DOTTED_RE = /^[^\p{L}]*(?:\p{L}\.){2,}[^\p{L}]*$/u;
// A single initial: one letter followed by a period ("A." in "A. Silva").
// Without this the article rules would lowercase "a." and "o." mid-title.
const INITIAL_RE = /^[^\p{L}\p{N}]*\p{L}\.[^\p{L}\p{N}]*$/u;

// ─── Roman numerals ──────────────────────────────────────────────────────────
// "seção ii" must come out as "Seção II", not "Seção Ii". A numeral is only
// obvious in context, though: "vi", "li" and "mi" are Portuguese words, "cm",
// "ml" and "cc" are units, and all of them are valid Roman numerals. So a
// numeral is uppercased when either
//   · the word before it names a numbered thing ("Seção", "Chapter", "Papa"), or
//   · it is two or more letters long and is not one of the ambiguous ones below.
// Single letters (I, V, X, L, C, D, M) need the lead word — nothing else could
// tell "Capítulo V" from an ordinary "v".

const ROMAN_RE = /^M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/;

/** Valid numerals that are also words, units or common abbreviations. */
const AMBIGUOUS_ROMAN = new Set([
    'VI', 'LI', 'MI', 'DI', 'CI', 'MIX',   // words (PT "vi", "li"; EN "mix")
    'CM', 'MM', 'ML', 'CL', 'DL', 'CC',    // units
    'CD', 'CV', 'DC', 'MC', 'MD',          // abbreviations
]);

/** Words that introduce a number, in Portuguese and English. */
const NUMBERING_LEAD_WORDS = new Set([
    // Portuguese
    'secao', 'subsecao', 'capitulo', 'parte', 'volume', 'tomo', 'livro', 'titulo',
    'anexo', 'apendice', 'artigo', 'art', 'regra', 'item', 'fase', 'etapa', 'nivel',
    'classe', 'tipo', 'grau', 'figura', 'tabela', 'quadro', 'emenda', 'edicao',
    'capitulos', 'secoes', 'guerra', 'seculo', 'papa', 'rei', 'rainha', 'dom',
    'imperador', 'luis', 'joao', 'pedro', 'henrique',
    // English
    'section', 'subsection', 'chapter', 'part', 'book', 'title', 'annex', 'appendix',
    'article', 'rule', 'phase', 'stage', 'level', 'class', 'type', 'grade', 'figure',
    'table', 'edition', 'amendment', 'war', 'century', 'king', 'queen', 'pope',
    'chapters', 'sections', 'volumes',
]);

/** Lowercased and stripped of accents, for the lead-word lookup. */
function leadWordKey(raw: string): string {
    return raw
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .replace(/[^\p{L}]/gu, '')
        .toLowerCase();
}

/**
 * True when the word is a Roman numeral used as a number here — see the note
 * above for what counts as sufficient indication.
 */
function isRomanNumeral(key: string, prevWord: string | undefined): boolean {
    if (key.length === 0 || !ROMAN_RE.test(key)) return false;
    if (prevWord && NUMBERING_LEAD_WORDS.has(leadWordKey(prevWord))) return true;
    return key.length >= 2 && !AMBIGUOUS_ROMAN.has(key);
}

/** Letters/digits only, uppercased — the lookup key for the acronym lists. */
function acronymKey(raw: string): string {
    return raw.replace(/[^\p{L}\p{N}]/gu, '').toUpperCase();
}

/**
 * Strips surrounding punctuation, keeping dots and hyphens that belong to the
 * word itself — "(e.g.," → "e.g.", so a dotted abbreviation can be looked up
 * with the trailing dot it is written with.
 */
function stripOuterPunctuation(raw: string): string {
    return raw.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}.-]+$/u, '');
}

/**
 * True for dotted abbreviations that are conventionally lowercase ("e.g.").
 * They are treated exactly like MINOR_WORDS: lowercase unless first or last.
 */
function isLowercaseDotted(rawWord: string): boolean {
    return (
        DOTTED_RE.test(rawWord) &&
        LOWERCASE_DOTTED.has(stripOuterPunctuation(rawWord).toLowerCase())
    );
}

/** True when the word ends in a lowercase plural "s" (before any punctuation). */
function hasPluralS(raw: string): boolean {
    return /s[^\p{L}\p{N}]*$/u.test(raw);
}

/**
 * Parses the user's custom acronym list: comma, semicolon, pipe or whitespace
 * separated, punctuation and case ignored ("GT, AB; nm" → GT, AB, NM).
 */
export function parseAcronymList(raw: string | undefined | null): Set<string> {
    const out = new Set<string>();
    for (const token of (raw || '').split(/[\s,;|]+/)) {
        const key = acronymKey(token);
        if (key.length >= 2) out.add(key);
    }
    return out;
}

/** True when every cased letter in the text is uppercase. */
function isAllUpper(text: string): boolean {
    const letters = [...text].filter(
        (c) => LETTER_RE.test(c) && (c !== c.toUpperCase() || c !== c.toLowerCase())
    );
    return (
        letters.length > 0 &&
        letters.every((c) => c === c.toUpperCase() && c !== c.toLowerCase())
    );
}

interface AcronymContext {
    /** Extra acronyms from the user setting, as returned by parseAcronymList. */
    extra?: Set<string>;
    /** Whether the surrounding text is entirely uppercase (signal 4 off). */
    allUpperSource?: boolean;
}

/**
 * How an acronym should be cased in Title Case, or null when the word is not
 * one.
 *
 *   'full'   — every letter uppercase ("AB", "U.S.A.")
 *   'plural' — every letter uppercase except the trailing "s" ("GTs")
 */
function acronymCasing(
    rawWord: string,
    ctx: AcronymContext,
    prevWord?: string
): 'full' | 'plural' | null {
    const key = acronymKey(rawWord);
    if (key.length < 2) {
        if (INITIAL_RE.test(rawWord)) return 'full';
        return isRomanNumeral(key, prevWord) ? 'full' : null;
    }

    const listed = (k: string) => BUILT_IN_ACRONYMS.has(k) || ctx.extra?.has(k) === true;

    if (listed(key)) return 'full';
    // "GTs" / "PDFs": the singular is listed and the source spells the plural
    // with a lowercase s.
    if (key.length > 2 && hasPluralS(rawWord) && listed(key.slice(0, -1))) return 'plural';

    if (DOTTED_RE.test(rawWord) && !isLowercaseDotted(rawWord)) return 'full';
    if (INITIAL_RE.test(rawWord)) return 'full';
    if (isRomanNumeral(key, prevWord)) return 'full';

    if (
        !ctx.allUpperSource &&
        UPPER_RUN_RE.test(rawWord) &&
        (rawWord.match(UPPERCASE_LETTER_RE) || []).length >= 2
    ) {
        return hasPluralS(rawWord) ? 'plural' : 'full';
    }

    return null;
}


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

export function detectCase(text: string, extraAcronyms?: Set<string>): CaseState {
    const letters = [...text].filter(
        (c) => LETTER_RE.test(c) && (c !== c.toUpperCase() || c !== c.toLowerCase())
    );
    if (letters.length === 0) return 'lower';

    if (isAllUpper(text)) return 'upper';

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

        // Acronyms are title-consistent when written the way Title Case would
        // write them; without this an "(AB)" would make the whole line read as
        // untitled and the cycle could never leave Title Case.
        const casing = acronymCasing(
            raw,
            { extra: extraAcronyms, allUpperSource: false },
            wordMatches[idx - 1]?.[0]
        );
        if (casing) {
            const body = casing === 'plural' ? wordLetters.slice(0, -1) : wordLetters;
            const tail = casing === 'plural' ? wordLetters.slice(-1) : [];
            return (
                body.every((c) => c === c.toUpperCase() && c !== c.toLowerCase()) &&
                tail.every((c) => c === c.toLowerCase())
            );
        }

        const isMinor =
            !isFirst && !isLast && (MINOR_WORDS.has(key) || isLowercaseDotted(raw));

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
function buildTitleCaseMap(fullText: string, extraAcronyms?: Set<string>): boolean[] {
    const map: boolean[] = new Array(fullText.length).fill(false);
    const acronymCtx: AcronymContext = {
        extra: extraAcronyms,
        allUpperSource: isAllUpper(fullText),
    };

    const wordRegex = /\S+/g;
    let match;
    const words: { start: number; end: number; raw: string }[] = [];
    while ((match = wordRegex.exec(fullText)) !== null) {
        words.push({ start: match.index, end: match.index + match[0].length, raw: match[0] });
    }

    words.forEach(({ start, end, raw }, idx) => {
        const isFirst = idx === 0;
        const isLast = idx === words.length - 1;

        // Acronyms are uppercase throughout, whatever position they sit in.
        const casing = acronymCasing(raw, acronymCtx, words[idx - 1]?.raw);
        if (casing) {
            const letterPositions: number[] = [];
            for (let i = start; i < end; i++) {
                if (LETTER_RE.test(fullText[i])) letterPositions.push(i);
            }
            // 'plural' leaves the trailing "s" of "GTs" lowercase.
            const upTo = casing === 'plural' ? letterPositions.length - 1 : letterPositions.length;
            for (let i = 0; i < upTo; i++) map[letterPositions[i]] = true;
            return;
        }

        // Strip surrounding punctuation for lookup (handles "or,", "(the", etc.)
        const key = raw.toLowerCase().replace(/[^\p{L}]/gu, '');
        const shouldCapitalize =
            isFirst || isLast || (!MINOR_WORDS.has(key) && !isLowercaseDotted(raw));

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
 *  2b. Acronyms and initialisms stay fully uppercase ("AB", "GT", "U.S.A.").
 *  3. Non-text elements (references, images, clozes) are left untouched
 *     and their character contribution is correctly accounted for.
 */
export function transformTitleCase(
    richText: any[],
    fullText: string,
    extraAcronyms?: Set<string>
): any[] {
    const map = buildTitleCaseMap(fullText, extraAcronyms);
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