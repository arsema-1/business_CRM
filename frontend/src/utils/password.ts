// Client-side mirror of backend/src/utils/password.ts.
// Used for instant guidance only — the server is the authority and also checks
// the password against known breach data.

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 72;

export function passwordIssues(
  password: string,
  opts: { email?: string; name?: string } = {}
): string[] {
  const issues: string[] = [];

  if (password.length < PASSWORD_MIN_LENGTH) {
    issues.push(`At least ${PASSWORD_MIN_LENGTH} characters`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    issues.push(`No more than ${PASSWORD_MAX_LENGTH} characters`);
  }

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (password.length > 0 && classes < 3) {
    issues.push("At least three of: lowercase, uppercase, numbers, symbols");
  }

  if (/(.)\1{3,}/.test(password)) {
    issues.push("No character repeated 4+ times in a row");
  }

  const lower = password.toLowerCase();
  const tokens = [opts.email?.split("@")[0], opts.name]
    .map((v) => v?.toLowerCase().trim())
    .filter((v): v is string => !!v && v.length >= 3);
  if (tokens.some((token) => lower.includes(token))) {
    issues.push("Must not contain your name or email");
  }

  return issues;
}

// 0–5, used by the strength meter.
export function passwordStrength(password: string): number {
  if (!password) return 0;
  let score = 0;
  if (password.length >= PASSWORD_MIN_LENGTH) score++;
  if (password.length >= 16) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;
  return score;
}

export const PASSWORD_GUIDANCE =
  "Use 12+ characters with a mix of upper and lower case, numbers and symbols. Avoid common phrases, your name or your email — known breached passwords are rejected.";
