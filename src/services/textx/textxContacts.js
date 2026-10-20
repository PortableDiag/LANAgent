import mongoose from 'mongoose';
import { sameNumber } from './textxStore.js';

/**
 * Phone contacts ALICE learned through TextX also land in its own contact book (the email
 * plugin's `email_contacts` memories), so "email Sam" and "text Sam" are one person. A phone
 * contact joins a card only when exactly one card has that name, alias or email; the card's
 * number is filled in when it has none and never overwritten. Cards are created only for
 * contacts with an email, because the contact book is keyed by email.
 */
export async function linkToContactBook(recs, logger = console) {
  if (!recs?.length || mongoose.connection.readyState !== 1) return 0;
  const { Memory } = await import('../../models/Memory.js');
  let linked = 0;
  for (const c of recs) {
    const name = String(c.name || '').trim();
    const nameRe = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    const or = [{ 'metadata.name': nameRe }, { 'metadata.aliases': nameRe }];
    if (c.emails?.length) or.push({ 'metadata.email': { $in: c.emails } });
    const cards = await Memory.find({ type: 'knowledge', 'metadata.category': 'email_contacts', $or: or }).limit(3).lean();
    if (cards.length !== 1 || !c.numbers?.length) continue;
    const card = cards[0];
    const have = card.metadata?.phone;
    if (have && c.numbers.some(n => sameNumber(n, have))) continue;
    if (have) continue; // a number the owner set by hand stays
    await Memory.updateOne({ _id: card._id }, { $set: { 'metadata.phone': c.numbers[0], 'metadata.phoneSource': 'textx' } });
    logger.info?.(`textx: contact book: ${card.metadata?.name || name} now has their phone number`);
    linked++;
  }
  return linked;
}

/** Contact-book cards (email plugin) with a phone number, matching a name exactly. */
export async function contactBookNumbers(name) {
  const q = String(name || '').trim();
  if (!q || mongoose.connection.readyState !== 1) return [];
  const { Memory } = await import('../../models/Memory.js');
  const re = new RegExp(`^${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  const cards = await Memory.find({ type: 'knowledge', 'metadata.category': 'email_contacts',
    'metadata.phone': { $nin: [null, ''] }, $or: [{ 'metadata.name': re }, { 'metadata.aliases': re }] }).limit(3).lean();
  return cards.map(c => ({ name: c.metadata.name || q, numbers: [String(c.metadata.phone)] }));
}
