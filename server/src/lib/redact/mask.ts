import { findSpans, knownEligible, type RuleOptions } from './rules.js';
import { register, knownPlaceholderFor, restoreValue, knownPlaceholders, type RedactKind } from './store.js';

// Outbound masking + inbound restore (Magpie internal/redact alignment).

/** Mask a plain text: replace each detected span's value with its placeholder.
 *  Also re-mask any already-known values that appear verbatim (so a value the
 *  vendor wrote about in its own words is masked again on the way out). */
export function maskText(text: string, opts: RuleOptions): string {
  if (!text) return text;
  const spans = findSpans(text, opts);
  // Apply from the end so earlier offsets stay valid.
  let out = text;
  const seen = new Set<string>();
  for (let i = spans.length - 1; i >= 0; i--) {
    const s = spans[i];
    const value = out.slice(s.start, s.end);
    const placeholder = register(value, s.kind);
    out = out.slice(0, s.start) + placeholder + out.slice(s.end);
    seen.add(value);
  }
  // Re-mask known values that appear verbatim but no rule matched this time
  // (e.g. the vendor referenced a placeholder in its own prose last turn).
  out = maskKnownValues(out, seen);
  return out;
}

/** Replace any registered known value appearing verbatim with its placeholder. */
function maskKnownValues(text: string, skip: Set<string>): string {
  // Only re-match values long enough to be safe (MIN_KNOWN_LEN).
  const placeholders = knownPlaceholders();
  if (placeholders.length === 0) return text;
  let out = text;
  // Longest values first to avoid partial replacement of a longer secret.
  const values = placeholders
    .map(p => ({ p, v: restoreValue(p)! }))
    .filter(e => knownEligible(e.v) && !skip.has(e.v))
    .sort((a, b) => b.v.length - a.v.length);
  for (const { v, p } of values) {
    if (out.includes(v)) out = out.split(v).join(p);
  }
  return out;
}

/** Restore all placeholders in a text back to their original values. */
export function restoreText(text: string): string {
  if (!text || !text.includes('{{')) return text;
  return text.replace(/\{\{([A-Z_]+)_([0-9a-z]{8})\}\}/g, (whole) => {
    return restoreValue(whole) ?? whole;
  });
}
