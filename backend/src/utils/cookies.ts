// Minimal cookie header parser. Express can *set* cookies natively
// (res.cookie), but parsing the request Cookie header needs either this or an
// extra dependency, so a few lines here are enough.
export function parseCookies(header?: string | string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  const raw = Array.isArray(header) ? header.join("; ") : header;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}
