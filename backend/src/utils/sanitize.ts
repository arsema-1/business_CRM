// Strip HTML tags and trim whitespace to prevent XSS via stored content
export function sanitizeString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return String(value)
    .replace(/<[^>]*>/g, "")
    .trim()
    .slice(0, 2000);
}

export function sanitizeBody(body: Record<string, unknown>, fields: string[]): void {
  for (const field of fields) {
    if (body[field] !== undefined) {
      body[field] = sanitizeString(body[field]);
    }
  }
}
