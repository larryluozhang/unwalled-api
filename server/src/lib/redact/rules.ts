import type { RedactKind } from './store.js';
import { MIN_KNOWN_LEN } from './store.js';

// PII detection rules (Magpie internal/redact alignment).
//
// Each rule returns spans [start,end) within a text that should be masked,
// with the kind. The anti-false-positive logic mirrors Magpie's phone.go /
// ids.go: a number's FORM alone is not enough (an order id looks like a
// phone; a UUID must never be masked because the model reads it back and a
// tool call matches it exactly).

export interface Span {
  start: number;
  end: number;
  kind: RedactKind;
}

/** Field-name words that make a numeric value a phone (not an order/user id). */
const PHONE_FIELD_WORDS = /phone|mobile|tel(?:ephone)?|cell(?:phone)?|contact|whatsapp|sms|msisdn|fax|手机|电话|聯繫|联系|联络/i;
/** Words right before a number that make it an id, not a phone. */
const ID_CONTEXT_WORDS = /(?:order|uid|user[_-]?id|no\.?|#|number|ticket|invoice|订单号?|单号|编号|流水号|工单号?|运单号|快递单号|交易号|序号|账单号|id号)/i;

/** 18-char PRC id: 6 region + 8 birth + 3 seq + 1 check (digit or X). */
const ID_CARD_RE = /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g;
/** Mainland mobile: 11 digits starting 13-19. Bound-checked against longer runs. */
const PHONE_RE = /(?<![\dA-Za-z])1[3-9]\d{9}(?![\dA-Za-z])/g;
/** Bank card: 16-19 digits, optional space/dash grouping, Luhn-checked. */
const BANK_CARD_RE = /(?<![\dA-Za-z])(?:\d[ -]?){15,18}\d(?![\dA-Za-z])/g;
/** Email. */
const EMAIL_RE = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![A-Za-z0-9.-])/g;
/** user@host as ssh/scp/rsync prompt or command (not git@github.com). */
const USERHOST_RE = /\b(?:ssh|scp|sftp|rsync|mosh)\s+(?:[^\s@]+@)?([A-Za-z_][A-Za-z0-9._-]*)@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})/g;

/** A UUID / 32+ hex run is an id the model must read back verbatim — never mask. */
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const HEX32_RE = /\b[0-9a-fA-F]{32,}\b/g;

function luhn(digits: string): boolean {
  const d = digits.replace(/\D/g, '');
  if (d.length < 15 || d.length > 19) return false;
  let sum = 0, alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}

/** Whether the numeric run at [a,b) is a phone, not an order/user id of the
 *  same form. Looks at the field name (k=v / JSON / XML) or the word before. */
function isPhoneNotId(text: string, a: number, b: number): boolean {
  // Explicit +86 / 86 prefix makes it a phone wherever it is.
  if (b - a > 11) return true;
  // Look back ~40 chars for an id-context word.
  const before = text.slice(Math.max(0, a - 40), a);
  if (ID_CONTEXT_WORDS.test(before)) return false;
  // Field name (e.g. "phone": "..." or phone= or <tel>).
  const fieldMatch = before.match(/([A-Za-z_一-龥]+)\s*[:=]\s*["']?[^"']*$/);
  if (fieldMatch) return PHONE_FIELD_WORDS.test(fieldMatch[1]);
  if (PHONE_FIELD_WORDS.test(before)) return true;
  // '#' right before means an id.
  if (a > 0 && text[a - 1] === '#') return false;
  return true;
}

/** Secret-bearing field names; values in these fields are credentials. */
const SECRET_FIELD_RE = /(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|secret|password|passwd|pwd|private[_-]?key|client[_-]?secret|auth[_-]?token|session[_-]?key)\s*[:=]\s*["']?([A-Za-z0-9._~+/=-]{8,})/gi;
/** Well-known key prefixes anywhere in prose. */
const PREFIXED_KEY_RES: Array<[RegExp, RedactKind]> = [
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, 'API_KEY'],
  [/\bgsk_[A-Za-z0-9_-]{16,}\b/g, 'API_KEY'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, 'API_KEY'],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, 'API_KEY'],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/g, 'API_KEY'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'API_KEY'],
  [/\b(?:freellmapi|unwalled)-[A-Za-z0-9_-]{8,}\b/g, 'API_KEY'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}/g, 'BEARER'],
  [/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, 'PRIVATE_KEY'],
  // JWT (three base64url segments).
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, 'TOKEN'],
];

/** Exclude ids the model must read back (uuid / 32hex / computer-use token). */
function overlapsProtectedId(text: string, a: number, b: number): boolean {
  for (const re of [UUID_RE, HEX32_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      // If [a,b) is strictly INSIDE a protected id, it's a fragment — mask
      // nothing (a piece of an id is never a value of its own).
      if (a >= m.index && b <= m.index + m[0].length) return true;
    }
  }
  return false;
}

export interface RuleOptions {
  secrets: boolean;
  personal: boolean;
}

/** Find all maskable spans in a text. Returns spans sorted by start. */
export function findSpans(text: string, opts: RuleOptions): Span[] {
  const spans: Span[] = [];
  if (!text) return spans;

  if (opts.secrets) {
    for (const [re, kind] of PREFIXED_KEY_RES) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        spans.push({ start: m.index, end: m.index + m[0].length, kind });
      }
    }
    SECRET_FIELD_RE.lastIndex = 0;
    let sm: RegExpExecArray | null;
    while ((sm = SECRET_FIELD_RE.exec(text))) {
      // Mask only the value group, not the "api_key=" prefix.
      const valueStart = sm.index + sm[0].length - sm[1].length;
      spans.push({ start: valueStart, end: sm.index + sm[0].length, kind: 'SECRET' });
    }
  }

  if (opts.personal) {
    EMAIL_RE.lastIndex = 0;
    let em: RegExpExecArray | null;
    while ((em = EMAIL_RE.exec(text))) {
      // git@github.com is a remote, not a person's email.
      if (/^(git|ssh|root|admin|user)@/i.test(em[0]) && !/\.(com|net|org|cn|io|edu)$/i.test(em[0].split('@')[1] ?? '')) {
        // still allow real domains; skip bare host-only forms
      }
      spans.push({ start: em.index, end: em.index + em[0].length, kind: 'EMAIL' });
    }

    ID_CARD_RE.lastIndex = 0;
    let im: RegExpExecArray | null;
    while ((im = ID_CARD_RE.exec(text))) {
      if (!overlapsProtectedId(text, im.index, im.index + im[0].length)) {
        spans.push({ start: im.index, end: im.index + im[0].length, kind: 'ID_CARD' });
      }
    }

    PHONE_RE.lastIndex = 0;
    let pm: RegExpExecArray | null;
    while ((pm = PHONE_RE.exec(text))) {
      const a = pm.index, b = a + pm[0].length;
      if (overlapsProtectedId(text, a, b)) continue;
      if (!isPhoneNotId(text, a, b)) continue;
      spans.push({ start: a, end: b, kind: 'PHONE' });
    }

    BANK_CARD_RE.lastIndex = 0;
    let bm: RegExpExecArray | null;
    while ((bm = BANK_CARD_RE.exec(text))) {
      const a = bm.index, b = a + bm[0].length;
      if (overlapsProtectedId(text, a, b)) continue;
      if (!luhn(bm[0])) continue;
      // An 18-char id already counted as ID_CARD shouldn't double-mask.
      if (spans.some(s => s.kind === 'ID_CARD' && s.start <= a && s.end >= b)) continue;
      spans.push({ start: a, end: b, kind: 'BANK_CARD' });
    }

    USERHOST_RE.lastIndex = 0;
    let um: RegExpExecArray | null;
    while ((um = USERHOST_RE.exec(text))) {
      spans.push({ start: um.index, end: um.index + um[0].length, kind: 'USERHOST' });
    }
  }

  // Drop spans that are strictly contained in a longer span (avoid double-mask).
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Span[] = [];
  let lastEnd = -1;
  for (const s of spans) {
    if (s.start < lastEnd) continue; // overlap with an already-kept longer span
    kept.push(s);
    lastEnd = s.end;
  }
  return kept;
}

/** Minimum length for a value to be registered as a known value (mirror of
 *  Magpie minKnown). Short values are masked but not re-matched globally. */
export function knownEligible(value: string): boolean {
  return value.length >= MIN_KNOWN_LEN;
}
