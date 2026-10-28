import mongoose from 'mongoose';

/**
 * One human (or another agent) across every channel ALICE talks on: the same Wayne by SMS, on a
 * DialX call, by email and on Telegram. Until 2026-10-23 each channel keyed people its own way
 * (an email card, a TextX contact by name, a free-text DialX name, a Telegram id), so nothing a
 * person said on one channel was known on another, and two people with one name merged.
 *
 * A person is found only by an exact identifier (number, email, Telegram id, bot id, P2P
 * fingerprint); a name alone never joins two records (services/people/personDirectory.js).
 */
const personSchema = new mongoose.Schema({
  name: { type: String, default: '' },
  aliases: { type: [String], default: [] },
  // Phone numbers as given, plus their last-10-digit keys for matching ("+1 (405) 555-0100" = "4055550100").
  numbers: { type: [String], default: [] },
  numberKeys: { type: [String], default: [] },
  emails: { type: [String], default: [] },          // lower-case
  telegramIds: { type: [String], default: [] },
  botIds: { type: [String], default: [] },
  fingerprints: { type: [String], default: [] },     // P2P peers
  isOwner: { type: Boolean, default: false },
  cardId: { type: mongoose.Schema.Types.ObjectId, default: null }, // the email contact-book card
  channels: { type: Map, of: Date, default: {} },    // channel -> last time seen there
  // Identifiers that pointed at two different people: kept for the owner to settle, never merged.
  conflicts: { type: [mongoose.Schema.Types.Mixed], default: [] },
  // ALICE's own reviewed note on this person, rewritten after each conversation (personMemory.learn).
  note: { type: String, default: '' },
  noteAt: { type: Date, default: null }
}, { timestamps: true, versionKey: false });

personSchema.index({ numberKeys: 1 });
personSchema.index({ emails: 1 });
personSchema.index({ telegramIds: 1 });
personSchema.index({ botIds: 1 });
personSchema.index({ fingerprints: 1 });
personSchema.index({ isOwner: 1 });

export const Person = mongoose.models.Person || mongoose.model('Person', personSchema);
export default Person;
