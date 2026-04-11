import mongoose from 'mongoose';
import moment from 'moment-timezone';
import { logger } from '../utils/logger.js';

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
      enum: ['notification', 'email', 'telegram'],
      default: 'telegram'
    },
    minutesBefore: {
      type: Number,
      default: 15
    },
    sent: {
      type: Boolean,
      default: false
    },
    sentAt: Date,
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