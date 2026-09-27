import axios from 'axios';
import { assertPublicUrl } from '../../utils/publicUrl.js';

/**
 * GET a URL that someone else chose (a feed, a product page, a domain to investigate).
 * Every hop — the first request and each redirect — must resolve to a public address, so a
 * link cannot walk the agent onto its own LAN. Redirects are followed by hand for that reason.
 */
export const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';

export async function fetchPublic(url, { headers = {}, timeout = 20000, maxRedirects = 5, responseType = 'text', maxBytes = 8 * 1024 * 1024 } = {}) {
  let current = await assertPublicUrl(url);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await axios.get(current, {
      headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9', ...headers },
      timeout,
      responseType,
      maxRedirects: 0,
      maxContentLength: maxBytes,
      validateStatus: () => true
    });
    if (res.status >= 300 && res.status < 400 && res.headers?.location) {
      current = await assertPublicUrl(new URL(res.headers.location, current).toString());
      continue;
    }
    return { status: res.status, data: res.data, headers: res.headers || {}, url: current };
  }
  throw new Error(`too many redirects from ${url}`);
}
