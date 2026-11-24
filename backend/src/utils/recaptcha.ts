// Verifies a reCAPTCHA v3 token server-side.
// Returns true when the score is above the threshold (default 0.5).
// If RECAPTCHA_SECRET_KEY is not set the check is skipped (dev mode).
//
// `expectedAction` binds the token to the form it was minted for, so a token
// harvested from one page cannot be replayed against another endpoint.

export async function verifyRecaptcha(
  token: string | undefined,
  expectedAction?: string
): Promise<boolean> {
  const secret = process.env.RECAPTCHA_SECRET_KEY;
  if (!secret) return true; // skip in dev when key is not configured

  if (!token) return false;

  const params = new URLSearchParams({
    secret,
    response: token,
  });

  let data: { success: boolean; score: number; action?: string };
  try {
    const res = await fetch("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      body: params,
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return false;
    data = (await res.json()) as typeof data;
  } catch {
    // Network failure or timeout — fail closed rather than assume a human
    return false;
  }

  if (expectedAction && data.action !== expectedAction) return false;

  const threshold = Number(process.env.RECAPTCHA_THRESHOLD ?? 0.5);
  return data.success && data.score >= threshold;
}
