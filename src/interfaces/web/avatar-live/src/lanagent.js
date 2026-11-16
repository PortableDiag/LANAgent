// LANAgent's side of AvatarX's page. The page is AvatarX's own (motion, props, VR, chat, talk); this file points it at
// the agent: every `/api/...` call goes to `/api/avatar-live/...` with the dashboard's login (the JWT the dashboard and
// the Android app keep in localStorage `lanagent_token`). Imported first, so the motion and prop loaders are covered too.
export const BASE = '/api/avatar-live';
const TOKEN_KEY = 'lanagent_token';

export function token() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
export function setToken(t) {
  try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch {}
}

const realFetch = window.fetch.bind(window);
// three's loaders fetch with an absolute URL inside a Request, the page's own code with a path: both are covered.
window.fetch = (input, init = {}) => {
  const isRequest = typeof Request !== 'undefined' && input instanceof Request;
  const raw = isRequest ? input.url : String(input?.url ?? input);
  let u;
  try { u = new URL(raw, location.href); } catch { return realFetch(input, init); }
  if (u.origin !== location.origin || !u.pathname.startsWith('/api/') || u.pathname.startsWith('/api/auth/') || u.pathname.startsWith(BASE + '/')) {
    return realFetch(input, init);
  }
  const target = BASE + u.pathname.slice(4) + u.search;
  const headers = new Headers(init.headers || (isRequest ? input.headers : undefined));
  const t = token();
  if (t && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${t}`);
  if (isRequest) return realFetch(new Request(target, { method: input.method, headers, body: init.body, signal: init.signal || input.signal, credentials: input.credentials }));
  return realFetch(target, { ...init, headers });
};

/** Signs in with the dashboard's password; the token is kept like the dashboard keeps it. */
export async function login(password) {
  const r = await realFetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  const v = await r.json().catch(() => ({}));
  if (!r.ok || !v.token) throw new Error(v.error || (r.status === 401 ? 'wrong password' : `the agent answered ${r.status}`));
  setToken(v.token);
}

/**
 * Server-sent events with the login header (EventSource cannot send one). Calls onmessage(data) per event and
 * reconnects after a drop. Returns { close }.
 */
export function events({ onopen, onerror, onmessage }) {
  let stopped = false;
  let ctrl = null;
  (async function run() {
    while (!stopped) {
      try {
        ctrl = new AbortController();
        const r = await window.fetch('/api/events', { signal: ctrl.signal });
        if (!r.ok) throw new Error(`${r.status}`);
        onopen?.();
        const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
            if (data) onmessage?.({ data });
          }
        }
      } catch {}
      if (stopped) return;
      onerror?.();
      await new Promise((res) => setTimeout(res, 3000));
    }
  })();
  return { close() { stopped = true; ctrl?.abort(); } };
}

/** An image the login protects, as a URL an <img> or a texture can load. */
export async function protectedImage(path) {
  const r = await window.fetch(path);
  if (!r.ok) throw new Error(`${r.status}`);
  return URL.createObjectURL(await r.blob());
}

const q = new URLSearchParams(location.search);
/** Embed mode (the Android app's chat and talk screens): the stage only, see-through, driven by the app. */
export const EMBED = q.get('embed') === '1';
/** In embed mode, keep the page's own background instead of showing what is behind it. */
export const EMBED_BACKGROUND = q.get('bg') === '1';
/** In embed mode, how far up the body sits, as a share of the view's height (0 to 0.45): room for the app's chat below. */
export const EMBED_LIFT = Math.min(0.45, Math.max(0, Number(q.get('lift')) || 0));
/** In embed mode, the app's own zoom for its frame (0.5 to 3), in place of the saved setting. */
export const EMBED_ZOOM = EMBED ? Math.min(3, Math.max(0, Number(q.get('zoom')) || 0)) : 0;
