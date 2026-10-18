import { logger } from '../../utils/logger.js';
import { sendRich } from './richMessage.js';
import { getAgentFeatures, setAgentFeatures, trustPeer, untrustPeer, ignoreBot, normalizeUsername, GUEST_MODES } from './agentFeatures.js';

/**
 * Telegram controls for the agent features (agentFeatures.js), owner only:
 *   /agents                       the switches as a card with buttons
 *   /trustbot @bot  /untrustbot @bot
 *   /askbot @bot <question>       ask another agent
 *   /peerskills @bot              what skills it offers
 *   /getskill @bot <name…>        ask it for skills (they arrive pending your approval)
 *   /sendskill @bot <name>        send it one of ours (privacy-audited ones only)
 * The same switches are in the web UI and at /api/telegram/agent-features.
 */

const GUEST_LABEL = { owner: 'only me', everyone: 'anyone', off: 'off' };
const nextGuest = (m) => GUEST_MODES[(GUEST_MODES.indexOf(m) + 1) % GUEST_MODES.length];

export function formatAgentsCard(f, bot = {}) {
  const on = (b) => (b ? 'on' : 'off');
  const peers = f.peers.length
    ? f.peers.map(p => `- @${p.username}${p.id ? '' : ' (not seen yet)'}${p.muted && Date.parse(p.muted) > Date.now() ? ' 🔇 muted' : ''}`).join('\n')
    : '- none yet: /trustbot @their_bot';
  const notes = [
    bot.supports_guest_queries === false && f.guestMode !== 'off' ? 'Guest Mode is not enabled for this bot in @BotFather yet.' : null,
    bot.has_topics_enabled === false && f.topics ? 'Topics are not enabled for this bot in @BotFather yet.' : null,
    f.botToBot ? 'Bot-to-bot also needs Bot-to-Bot Communication Mode in @BotFather, on both bots.' : null
  ].filter(Boolean);
  const rich = [
    '### 🤝 Telegram agents',
    `| Feature | State |\n|---|---|\n| Bot-to-bot | **${on(f.botToBot)}** |\n| Guest mode (summon me by @mention) | **${GUEST_LABEL[f.guestMode]}** |\n| Topics as separate chats | **${on(f.topics)}** |`,
    `**Trusted agents**\n${peers}`,
    notes.length ? notes.map(n => `> ${n}`).join('\n') : ''
  ].filter(Boolean).join('\n\n');
  const text = [
    '🤝 Telegram agents',
    `Bot-to-bot: ${on(f.botToBot)}\nGuest mode: ${GUEST_LABEL[f.guestMode]}\nTopics: ${on(f.topics)}`,
    `Trusted agents:\n${peers.replace(/^- /gm, '• ')}`,
    notes.join('\n')
  ].filter(Boolean).join('\n\n');
  const keyboard = { inline_keyboard: [
    [{ text: `Bot-to-bot: turn ${f.botToBot ? 'off' : 'on'}`, callback_data: `tgagents:b2b:${f.botToBot ? 'off' : 'on'}` }],
    [{ text: `Guest mode → ${GUEST_LABEL[nextGuest(f.guestMode)]}`, callback_data: `tgagents:guest:${nextGuest(f.guestMode)}` }],
    [{ text: `Topics: turn ${f.topics ? 'off' : 'on'}`, callback_data: `tgagents:topics:${f.topics ? 'off' : 'on'}` }]
  ] };
  return { rich, text, keyboard };
}

/** "@bot rest of the line" → { bot, rest } */
export function splitBotArg(text) {
  const m = /^\/\w+(?:@\w+)?\s+(@?\w+)\s*([\s\S]*)$/.exec(String(text || '').trim());
  if (!m) return null;
  return { bot: normalizeUsername(m[1]), rest: m[2].trim() };
}

export function installAgentCommands(bot, { isMaster, getLink, getBotInfo }) {
  const showCard = async (ctx) => {
    const card = formatAgentsCard(await getAgentFeatures(), getBotInfo() || {});
    const sent = await sendRich(ctx.telegram, ctx.chat.id, card.rich, { replyMarkup: card.keyboard, threadId: ctx.message?.message_thread_id });
    if (!sent) await ctx.reply(card.text, { reply_markup: card.keyboard });
  };
  const ownerOnly = (fn) => async (ctx) => {
    if (!isMaster(ctx)) return;
    try { await fn(ctx); } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  };
  const withBot = (fn, usage) => ownerOnly(async (ctx) => {
    const a = splitBotArg(ctx.message?.text);
    if (!a) return ctx.reply(`Usage: ${usage}`);
    await fn(ctx, a);
  });

  bot.command('agents', ownerOnly(showCard));
  bot.command('trustbot', withBot(async (ctx, { bot: u }) => {
    await trustPeer(u);
    const { botToBot } = await getAgentFeatures();
    await ctx.reply(`✅ @${u} is a trusted agent. It can ask me questions and send skills (which wait for your approval).${botToBot ? '' : ' Bot-to-bot is OFF: turn it on with /agents.'}`);
  }, '/trustbot @their_bot'));
  bot.command('untrustbot', withBot(async (ctx, { bot: u }) => {
    await ctx.reply((await untrustPeer(u)) ? `🚫 @${u} is no longer trusted.` : `@${u} was not trusted.`);
  }, '/untrustbot @their_bot'));
  bot.command('askbot', withBot(async (ctx, { bot: u, rest }) => {
    if (!rest) return ctx.reply('Usage: /askbot @their_bot your question');
    await ctx.reply(`⏳ Asking @${u}…`);
    const answer = await getLink().ask(u, rest);
    const sent = await sendRich(ctx.telegram, ctx.chat.id, `**@${u} answered:**\n\n${answer}`, { threadId: ctx.message?.message_thread_id });
    if (!sent) await ctx.reply(`@${u} answered:\n\n${answer}`);
  }, '/askbot @their_bot your question'));
  bot.command('peerskills', withBot(async (ctx, { bot: u }) => {
    const skills = await getLink().listSkills(u);
    await ctx.reply(skills.length
      ? `🧩 @${u} offers ${skills.length} skill(s):\n\n${skills.map(s => `• ${s.name} — ${s.description}`).join('\n')}\n\nGet one with /getskill @${u} <name>`
      : `@${u} offers no skills right now.`);
  }, '/peerskills @their_bot'));
  bot.command('getskill', withBot(async (ctx, { bot: u, rest }) => {
    const names = await getLink().requestSkills(u, rest);
    await ctx.reply(`📨 Asked @${u} for ${names.join(', ')}. Each one arrives waiting for your approval.`);
  }, '/getskill @their_bot skill-name'));
  bot.command('sendskill', withBot(async (ctx, { bot: u, rest }) => {
    if (!rest) return ctx.reply('Usage: /sendskill @their_bot skill-name');
    await getLink().sendSkill(u, rest.split(/\s+/)[0]);
    await ctx.reply(`📤 Sent "${rest.split(/\s+/)[0]}" to @${u}.`);
  }, '/sendskill @their_bot skill-name'));

  bot.action(/^tgagents:(b2b|guest|topics):(\w+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!isMaster(ctx)) return;
    const [, what, value] = ctx.match;
    try {
      if (what === 'b2b') await setAgentFeatures({ botToBot: value === 'on' });
      if (what === 'topics') await setAgentFeatures({ topics: value === 'on' });
      if (what === 'guest') await setAgentFeatures({ guestMode: value });
      logger.info(`[agents] owner set ${what} → ${value} from Telegram`);
      const card = formatAgentsCard(await getAgentFeatures(), getBotInfo() || {});
      await ctx.editMessageReplyMarkup(card.keyboard).catch(() => {});
      await ctx.reply(`⚙️ ${what === 'b2b' ? 'Bot-to-bot' : what === 'topics' ? 'Topics' : 'Guest mode'}: ${what === 'guest' ? GUEST_LABEL[value] : value}.`);
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });
  bot.action(/^tgpeer_(trust|ignore):(\w+)$/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!isMaster(ctx)) return;
    const [, verb, u] = ctx.match;
    try {
      if (verb === 'trust') await trustPeer(u); else await ignoreBot(u);
      await ctx.editMessageReplyMarkup(undefined).catch(() => {});
      await ctx.reply(verb === 'trust' ? `✅ @${u} is now a trusted agent.` : `🙈 I will ignore @${u} from now on.`);
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });
}
