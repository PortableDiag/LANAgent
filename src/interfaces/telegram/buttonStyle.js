/**
 * Colored inline buttons (Bot API 9.4 `style`: success = green, danger = red, primary = blue).
 *
 * Keyboards are built in a dozen places (dashboard, approvals, skill sharing, the Trellis
 * listener), and they already say what a button does with its leading emoji. Styling them
 * here, on the way out, colors every one of them — including keyboards added later — without
 * touching each builder. A button that sets its own style keeps it.
 */

const RULES = [
  [/^\s*✅/u, 'success'],
  [/^\s*(❌|🗑|⛔|🛑|⏹)/u, 'danger']
];

export function styleFor(text) {
  for (const [re, style] of RULES) if (re.test(String(text || ''))) return style;
  return null;
}

/** Returns reply_markup with styles added, or the input unchanged. Never mutates it. */
export function styleReplyMarkup(markup) {
  if (typeof markup === 'string') {
    try {
      const parsed = JSON.parse(markup);
      const styled = styleReplyMarkup(parsed);
      return styled === parsed ? markup : JSON.stringify(styled);
    } catch {
      return markup;
    }
  }
  const rows = markup?.inline_keyboard;
  if (!Array.isArray(rows)) return markup;
  let changed = false;
  const inline_keyboard = rows.map(row => Array.isArray(row) ? row.map(btn => {
    if (!btn || btn.style) return btn;
    const style = styleFor(btn.text);
    if (!style) return btn;
    changed = true;
    return { ...btn, style };
  }) : row);
  return changed ? { ...markup, inline_keyboard } : markup;
}

/** Wrap a Telegraf `Telegram` instance's callApi so every keyboard it sends is styled. */
export function installButtonStyles(telegram) {
  if (!telegram || telegram.__buttonStyles || typeof telegram.callApi !== 'function') return telegram;
  const original = telegram.callApi.bind(telegram);
  telegram.callApi = (method, payload = {}, ...rest) => {
    if (payload && payload.reply_markup) {
      const reply_markup = styleReplyMarkup(payload.reply_markup);
      if (reply_markup !== payload.reply_markup) payload = { ...payload, reply_markup };
    }
    return original(method, payload, ...rest);
  };
  telegram.__buttonStyles = true;
  return telegram;
}
