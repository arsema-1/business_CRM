// Shared reCAPTCHA v3 loader.
// When VITE_RECAPTCHA_SITE_KEY is unset the helper resolves to undefined and
// the server skips verification too (development mode).

const SITE_KEY = import.meta.env.VITE_RECAPTCHA_SITE_KEY as string | undefined;

declare global {
  interface Window {
    grecaptcha: {
      ready: (cb: () => void) => void;
      execute: (key: string, opts: { action: string }) => Promise<string>;
    };
  }
}

let loading: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (!SITE_KEY) return Promise.resolve();

  if (!loading) {
    loading = new Promise<void>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>("script[data-recaptcha]");
      const script = existing ?? document.createElement("script");
      script.src = `https://www.google.com/recaptcha/api.js?render=${SITE_KEY}`;
      script.async = true;
      script.dataset.recaptcha = "true";
      script.addEventListener("load", () => window.grecaptcha.ready(() => resolve()), { once: true });
      script.addEventListener("error", () => {
        loading = null;
        reject(new Error("Could not load reCAPTCHA"));
      }, { once: true });
      if (!existing) document.head.appendChild(script);
    });
  }

  return loading;
}

export function isRecaptchaConfigured() {
  return Boolean(SITE_KEY);
}

// Returns a v3 token bound to `action`, or undefined when CAPTCHA is disabled.
export async function executeRecaptcha(action: string): Promise<string | undefined> {
  if (!SITE_KEY) return undefined;
  await loadScript();
  return window.grecaptcha.execute(SITE_KEY, { action });
}
