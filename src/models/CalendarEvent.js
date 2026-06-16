import mongoose from 'mongoose';
import moment from 'moment-timezone';
import NodeCache from 'node-cache';
import { logger } from '../utils/logger.js';

// 60-second cache for ICS feed payloads keyed by query+options.
const icsFeedCache = new NodeCache({ stdTTL: 60, checkperiod: 120 });

const calendarEventSchema = new mongoose.Schema({
  // Basic information
  title: {
    type: String,
    required: true,
    trim: true
  },

  description: {
    type: String,
    trim: true
  },

  location: {
    type: String,
    trim: true
  },

  // Timing
  startDate: {
    type: Date,
    required: true,
    index: true
  },

  endDate: {
    type: Date,
    required: true
  },

  allDay: {
    type: Boolean,
    default: false
  },

  timezone: {
    type: String,
    default: 'America/Los_Angeles'
  },

  // Recurrence (RRule format for complex patterns)
  recurrence: {
    enabled: {
      type: Boolean,
      default: false
    },
    rule: String, // RRule string (e.g., "FREQ=WEEKLY;BYDAY=MO,WE,FR")
    endDate: Date, // When recurrence ends
    count: Number, // Or end after N occurrences
    exceptions: [Date] // Dates to skip
  },

  // Reminders
  reminders: [{
    type: {
      type: String,
      enum: ['notification', 'email', 'telegram', 'sms', 'push'],
      default: 'telegram'
    },
    minutesBefore: {
      type: Number,
      default: 15
    },
    // Repeating reminder interval in minutes leading up to the event.
    // When set (>0), the reminder fires every N minutes from minutesBefore until startDate is reached.
    customInterval: {
      type: Number,
      default: null
    },
    // Destination override for sms/push (phone number, FCM token). Falls back to env defaults.
    target: String,
    sent: {
      type: Boolean,
      default: false
    },
    sentAt: Date,
    lastSentAt: Date, // Last time a recurring (customInterval) reminder fired
    jobId: String // Agenda job ID for this reminder
  }],

  // Organization
  category: {
    type: String,
    enum: ['personal', 'work', 'meeting', 'reminder', 'deadline', 'birthday', 'holiday', 'other'],
    default: 'personal',
    index: true
  },

  color: {
    type: String,
    default: '#4285f4' // Google Calendar blue
  },

  priority: {
    type: String,
    enum: ['low', 'normal', 'high'],
    default: 'normal'
  },

  // Status
  status: {
    type: String,
    enum: ['confirmed', 'tentative', 'cancelled'],
    default: 'confirmed',
    index: true
  },

  // Attendees (optional)
  attendees: [{
    name: String,
    email: String,
    status: {
      type: String,
      enum: ['pending', 'accepted', 'declined', 'tentative'],
      default: 'pending'
    },
    timezone: String // New field for attendee timezone
  }],

  // Source tracking
  source: {
    type: String,
    enum: ['manual', 'telegram', 'email', 'web', 'import'],
    default: 'manual'
  },

  // External references (for future sync capabilities)
  externalId: String,
  externalSource: String,

  // Creator
  createdBy: {
    userId: String,
    source: String
  },

  // Notes/attachments
  notes: String,
  attachments: [{
    name: String,
    url: String,
    type: String
  }]
}, {
  timestamps: true
});

// Indexes for efficient queries
calendarEventSchema.index({ startDate: 1, endDate: 1 });
calendarEventSchema.index({ 'recurrence.enabled': 1 });
calendarEventSchema.index({ createdAt: -1 });

// Virtual for duration in minutes
calendarEventSchema.virtual('durationMinutes').get(function() {
  if (!this.startDate || !this.endDate) return 0;
  return Math.round((this.endDate - this.startDate) / (1000 * 60));
});

// Methods
calendarEventSchema.methods.isOngoing = function() {
  const now = new Date();
  return this.startDate <= now && this.endDate >= now;
};

calendarEventSchema.methods.isPast = function() {
  return this.endDate < new Date();
};

calendarEventSchema.methods.isUpcoming = function(withinMinutes = 60) {
  const now = new Date();
  const threshold = new Date(now.getTime() + withinMinutes * 60 * 1000);
  return this.startDate > now && this.startDate <= threshold;
};

// Mark a reminder as sent
calendarEventSchema.methods.markReminderSent = function(reminderIndex) {
  if (this.reminders[reminderIndex]) {
    this.reminders[reminderIndex].sent = true;
    this.reminders[reminderIndex].sentAt = new Date();
  }
  return this.save();
};

/**
 * Convert event times for an attendee based on their timezone
 * @param {Object} attendee - The attendee object
 * @returns {Object} - Converted start and end times
 */
calendarEventSchema.methods.convertTimesForAttendee = function(attendee) {
  if (!attendee.timezone) {
    logger.warn(`Attendee ${attendee.name} does not have a timezone specified.`);
    return { startDate: this.startDate, endDate: this.endDate };
  }

  try {
    const startDate = moment.tz(this.startDate, this.timezone).tz(attendee.timezone).toDate();
    const endDate = moment.tz(this.endDate, this.timezone).tz(attendee.timezone).toDate();
    return { startDate, endDate };
  } catch (error) {
    logger.error(`Error converting times for attendee ${attendee.name}: ${error.message}`);
    return { startDate: this.startDate, endDate: this.endDate };
  }
};

/**
 * Convert event times for all attendees based on their respective time zones
 * @returns {Array} - Array of objects containing attendee and their converted times
 */
calendarEventSchema.methods.convertTimesForAllAttendees = function() {
  return this.attendees.map(attendee => {
    const convertedTimes = this.convertTimesForAttendee(attendee);
    return {
      attendee,
      convertedStartDate: convertedTimes.startDate,
      convertedEndDate: convertedTimes.endDate
    };
  });
};

// ========== ICS (iCalendar / RFC 5545) export ==========

function _icsFormatUTC(date) {
  return moment(date).utc().format('YYYYMMDD[T]HHmmss[Z]');
}

function _icsEscape(text = '') {
  return (text ?? '').toString()
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// RFC 5545 §3.1: lines >75 octets must be folded with CRLF + single space.
function _icsFold(content) {
  const crlf = '\r\n';
  const lines = content.replace(/\r?\n/g, crlf).split(crlf);
  const out = [];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  for (const line of lines) {
    let bytes = encoder.encode(line);
    if (bytes.length <= 75) { out.push(line); continue; }
    let start = 0;
    let first = true;
    while (start < bytes.length) {
      let end = Math.min(start + 75, bytes.length);
      // Back off until the slice decodes cleanly (multi-byte boundary)
      while (end > start + 1) {
        try {
          const chunk = decoder.decode(bytes.slice(start, end), { stream: false });
          if (!chunk.includes('�')) break;
        } catch { /* keep shrinking */ }
        end--;
      }
      const chunk = decoder.decode(bytes.slice(start, end));
      out.push(first ? chunk : ' ' + chunk);
      first = false;
      start = end;
    }
  }
  return out.join(crlf);
}

// RFC 5545 PRIORITY: 0=unset, 1-4=high, 5=normal, 6-9=low
function _icsPriority(priority) {
  switch (priority) {
    case 'high': return 1;
    case 'low': return 9;
    default: return 5;
  }
}

function _icsStatus(status) {
  switch ((status || '').toLowerCase()) {
    case 'cancelled': return 'CANCELLED';
    case 'tentative': return 'TENTATIVE';
    default: return 'CONFIRMED';
  }
}

function _icsRRule(event) {
  if (!event?.recurrence?.enabled) return null;
  const parts = [];
  if (event.recurrence.rule) parts.push(event.recurrence.rule);
  if (Number.isInteger(event.recurrence.count)) parts.push(`COUNT=${event.recurrence.count}`);
  if (event.recurrence.endDate) parts.push(`UNTIL=${_icsFormatUTC(event.recurrence.endDate)}`);
  return parts.length ? `RRULE:${parts.join(';')}` : null;
}

function _icsAttendeeLines(attendees = []) {
  const lines = [];
  for (const a of attendees || []) {
    if (!a?.email) continue;
    const cn = a.name ? `;CN=${_icsEscape(a.name)}` : '';
    const partstatMap = { accepted: 'ACCEPTED', declined: 'DECLINED', tentative: 'TENTATIVE' };
    const partstat = partstatMap[(a.status || '').toLowerCase()] || 'NEEDS-ACTION';
    lines.push(`ATTENDEE${cn};PARTSTAT=${partstat};ROLE=REQ-PARTICIPANT;RSVP=FALSE:mailto:${a.email}`);
  }
  return lines;
}

function _icsAlarmLines(reminders = []) {
  const lines = [];
  for (const r of reminders || []) {
    if (typeof r?.minutesBefore !== 'number') continue;
    const minutes = Math.max(0, r.minutesBefore);
    lines.push('BEGIN:VALARM');
    lines.push('ACTION:DISPLAY');
    lines.push('DESCRIPTION:Event reminder');
    lines.push(`TRIGGER:-PT${minutes}M`);
    if (r.customInterval > 0) {
      const count = Math.floor(minutes / r.customInterval);
      if (count > 0) {
        lines.push(`REPEAT:${count}`);
        lines.push(`DURATION:PT${r.customInterval}M`);
      }
    }
    lines.push('END:VALARM');
  }
  return lines;
}

function _uidDomain() {
  return process.env.CALENDAR_UID_DOMAIN || process.env.AGENT_NAME || 'lanagent.local';
}

calendarEventSchema.methods.toICS = function({ uid, url, includeReminders = true } = {}) {
  try {
    const lines = [];
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uid || `${this._id}@${_uidDomain()}`}`);
    lines.push(`DTSTAMP:${_icsFormatUTC(new Date())}`);
    lines.push(`DTSTART:${_icsFormatUTC(this.startDate)}`);
    lines.push(`DTEND:${_icsFormatUTC(this.endDate)}`);
    if (this.title) lines.push(`SUMMARY:${_icsEscape(this.title)}`);
    if (this.description) lines.push(`DESCRIPTION:${_icsEscape(this.description)}`);
    if (this.location) lines.push(`LOCATION:${_icsEscape(this.location)}`);
    lines.push(`STATUS:${_icsStatus(this.status)}`);
    if (this.category) lines.push(`CATEGORIES:${_icsEscape(this.category)}`);
    lines.push(`PRIORITY:${_icsPriority(this.priority)}`);
    if (url) lines.push(`URL:${_icsEscape(url)}`);

    const rrule = _icsRRule(this);
    if (rrule) lines.push(rrule);
    for (const ex of (this.recurrence?.exceptions || [])) {
      if (ex) lines.push(`EXDATE:${_icsFormatUTC(ex)}`);
    }
    for (const att of _icsAttendeeLines(this.attendees)) lines.push(att);
    if (includeReminders) {
      for (const al of _icsAlarmLines(this.reminders)) lines.push(al);
    }
    lines.push('END:VEVENT');

    return _icsFold(lines.join('\r\n'));
  } catch (err) {
    logger.error(`toICS failed for event ${this?._id}: ${err.message}`);
    return _icsFold([
      'BEGIN:VEVENT',
      `UID:${uid || `${this?._id || 'unknown'}@${_uidDomain()}`}`,
      `DTSTAMP:${_icsFormatUTC(new Date())}`,
      'SUMMARY:Event',
      'END:VEVENT'
    ].join('\r\n'));
  }
};

calendarEventSchema.statics.toICSFeed = async function(query = {}, { url, includeReminders = true } = {}) {
  const cacheKey = `ics:${JSON.stringify(query)}:${includeReminders ? 1 : 0}:${url || ''}`;
  const cached = icsFeedCache.get(cacheKey);
  if (cached) return cached;

  try {
    const events = await this.find(query).sort({ startDate: 1 });
    const lines = [
      'BEGIN:VCALENDAR',
      'PRODID:-//LANAgent//CalendarEvent//EN',
      'VERSION:2.0',
      'CALSCALE:GREGORIAN',
      `X-WR-CALNAME:${_icsEscape(process.env.CALENDAR_NAME || 'LANAgent Calendar')}`,
      `X-WR-TIMEZONE:${_icsEscape(process.env.CALENDAR_TIMEZONE || 'UTC')}`
    ];
    for (const ev of events) {
      const evUrl = url ? `${url.replace(/\/+$/, '')}/events/${ev._id}` : undefined;
      try {
        lines.push(ev.toICS({ url: evUrl, includeReminders }));
      } catch (e) {
        logger.error(`toICSFeed: skipping bad event ${ev?._id}: ${e.message}`);
      }
    }
    lines.push('END:VCALENDAR');
    const folded = _icsFold(lines.join('\r\n'));
    icsFeedCache.set(cacheKey, folded);
    return folded;
  } catch (err) {
    logger.error(`toICSFeed failed: ${err.message}`);
    return _icsFold([
      'BEGIN:VCALENDAR',
      'PRODID:-//LANAgent//CalendarEvent//EN',
      'VERSION:2.0',
      'CALSCALE:GREGORIAN',
      'END:VCALENDAR'
    ].join('\r\n'));
  }
};

// Static methods
calendarEventSchema.statics.findUpcoming = function(days = 7) {
  const now = new Date();
  const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  return this.find({
    startDate: { $gte: now, $lte: future },
    status: { $ne: 'cancelled' }
  }).sort({ startDate: 1 });
};

calendarEventSchema.statics.findByDateRange = function(startDate, endDate) {
  return this.find({
    $or: [
      // Events that start within range
      { startDate: { $gte: startDate, $lte: endDate } },
      // Events that end within range
      { endDate: { $gte: startDate, $lte: endDate } },
      // Events that span the entire range
      { startDate: { $lte: startDate }, endDate: { $gte: endDate } }
    ],
    status: { $ne: 'cancelled' }
  }).sort({ startDate: 1 });
};

calendarEventSchema.statics.findByDay = function(date) {
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date);
  dayEnd.setHours(23, 59, 59, 999);
  return this.findByDateRange(dayStart, dayEnd);
};

calendarEventSchema.statics.findToday = function() {
  return this.findByDay(new Date());
};

calendarEventSchema.statics.findPendingReminders = function() {
  const now = new Date();
  return this.find({
    startDate: { $gte: now },
    status: { $ne: 'cancelled' },
    'reminders.sent': false
  });
};

calendarEventSchema.statics.findByCategory = function(category, limit = 50) {
  return this.find({ category, status: { $ne: 'cancelled' } })
    .sort({ startDate: 1 })
    .limit(limit);
};

export const CalendarEvent = mongoose.model('CalendarEvent', calendarEventSchema);