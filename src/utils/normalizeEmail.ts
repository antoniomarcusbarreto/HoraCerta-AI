// Firebase enforces exact-string email uniqueness for the password provider,
// so two accounts can only ever share a "visually identical" email if the
// strings aren't actually byte-identical — typically an invisible/zero-width
// Unicode character (mobile keyboard autocomplete, copy-paste) that plain
// .trim() doesn't strip since it isn't ASCII/Unicode whitespace. Stripping
// these before every Auth call keeps such near-duplicates from silently
// resolving to different accounts (see server/app.ts's normalizeEmail, kept
// in sync with this one).
const INVISIBLE_CODE_POINTS = [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff, 0x00ad, 0x00a0];
const INVISIBLE_CHARS_RE = new RegExp(
  `[${INVISIBLE_CODE_POINTS.map((c) => String.fromCodePoint(c)).join("")}]`,
  "g"
);

export function normalizeEmail(email: string): string {
  return email.replace(INVISIBLE_CHARS_RE, "").trim().toLowerCase();
}
