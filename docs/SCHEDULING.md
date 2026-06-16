# LANAgent Scheduling Capabilities

## Overview

LANAgent uses Agenda.js with MongoDB for advanced task scheduling. The agent can schedule tasks through natural language or programmatic interfaces.

## Natural Language Examples

### Reminders
- "remind me in 30 minutes to check the logs"
- "remind me tomorrow at 2pm to deploy updates"
- "set a daily reminder at 9am to check emails"

### Scheduled Tasks
- "run the backup script tonight at 3am"
- "schedule system maintenance for Sunday at 2am"
- "check disk space every 6 hours"
- "run bug detection every day at noon"

### Email Scheduling
- "send an email to John tomorrow at 9am"
- "schedule email to alice@example.com at 5:30 PM on Friday"
- "email reminder to myself next Monday morning"
- "send birthday wishes to Mom on December 25th at 8am"

### Recurring Email Scheduling
- "send daily status email to team at 9am"
- "schedule weekly report every Monday morning"
- "email monthly invoice on the 1st"
- "send reminder every 2 hours"
- "email summary every Friday at 5pm"

### Recurring Tasks
- "check emails every 30 minutes"
- "monitor CPU usage every 5 minutes"
- "generate weekly report every Monday at 9am"
- "clean up logs daily at midnight"

## Programmatic Access

The agent has full access to scheduling through `this.scheduler.agenda`:

### One-Time Tasks
```javascript
// Schedule for specific time
await this.scheduler.agenda.schedule('tomorrow at noon', 'taskName', { data });
await this.scheduler.agenda.schedule('in 20 minutes', 'reminder', { message });

// Schedule for specific date
await this.scheduler.agenda.schedule(new Date('2025-12-31'), 'yearEnd', { data });
```

### Recurring Tasks
```javascript
// Repeat at intervals
await this.scheduler.agenda.every('30 minutes', 'checkEmail');
await this.scheduler.agenda.every('1 hour', 'systemCheck');
await this.scheduler.agenda.every('0 2 * * *', 'dailyBackup'); // Cron format

// Define recurring with data
await this.scheduler.agenda.every('1 day', 'generateReport', {
  reportType: 'daily',
  recipients: ['admin@example.com']
});
```

### Immediate Execution
```javascript
// Run now
await this.scheduler.agenda.now('urgentTask', { priority: 'high' });
```

### Job Management
```javascript
// Cancel jobs
await this.scheduler.agenda.cancel({ name: 'taskName' });
await this.scheduler.agenda.cancel({ 'data.userId': 'user123' });

// List jobs
const jobs = await this.scheduler.agenda.jobs({ name: 'reminder' });
const allJobs = await this.scheduler.agenda.jobs({});
```

## Built-in Scheduled Jobs

LANAgent automatically schedules these recurring jobs:

1. **Email Check** - Every 3 minutes
2. **System Health Check** - Every minute
3. **Task Reminders** - As scheduled by users
4. **Scheduled Email Delivery** - As scheduled by users
5. **System Stats Collection** - Every 10 minutes
6. **Weekly Report** - Every Monday at 9 AM
7. **Reminder Cleanup** - Daily at 4 AM UTC
8. **Self-Modification Check** - Based on configuration
9. **Bug Detection Scan** - Daily at configured time
10. **Plugin Development Check** - Based on configuration

## Special Methods

### scheduleReminder()
Convenience method for scheduling reminders:
```javascript
const result = await this.scheduler.scheduleReminder(
  'Check deployment status',
  30, // minutes from now
  'userId',
  { notificationMethod: 'both' } // telegram, email, or both
);
```

### Email Scheduling
The email plugin provides methods for scheduling emails:
```javascript
// Schedule an email
const emailPlugin = this.apiManager.getPlugin('email');
await emailPlugin.execute({
  action: 'schedule',
  to: 'user@example.com',
  subject: 'Meeting Reminder',
  sendAt: '2025-01-15T14:00:00Z', // ISO 8601 format
  text: 'Don\'t forget about our meeting at 2pm!'
});

// List scheduled emails
const scheduled = await emailPlugin.execute({
  action: 'listScheduled'
});

// Cancel a scheduled email
await emailPlugin.execute({
  action: 'cancelScheduled',
  jobId: 'job-id-here'
});

// Schedule a recurring email
await emailPlugin.execute({
  action: 'scheduleRecurring',
  to: 'team@example.com',
  subject: 'Daily Status Report',
  recurrence: '0 9 * * *', // Every day at 9am
  text: 'Here is today\'s status report...'
});

// List recurring emails
const recurring = await emailPlugin.execute({
  action: 'listRecurring'
});

// Cancel a recurring email
await emailPlugin.execute({
  action: 'cancelRecurring',
  jobId: 'job-id-here'
});
```

Supported recurrence patterns:
- Intervals: `"5 minutes"`, `"2 hours"`, `"1 day"`
- Named patterns: `"daily"`, `"weekly"`, `"monthly"`
- Cron expressions: `"0 9 * * 1"` (Monday at 9am), `"0 17 * * 5"` (Friday at 5pm)

### Background Service Scheduling
Services can schedule their own checks:
```javascript
// Self-modification service
await this.scheduler.agenda.every('30 minutes', 'self-modification-check');

// Bug detection service
await this.scheduler.agenda.every('1 day', 'bug-detection-scan', {
  time: '02:00'
});
```

## Natural Language Processing

When users request scheduling through natural language, the agent:
1. Detects scheduling intent via AI
2. Extracts time parameters (relative or absolute)
3. Identifies the task to schedule
4. Creates appropriate Agenda job
5. Confirms with user

Examples of understood formats:
- Relative: "in 30 minutes", "tomorrow", "next week"
- Absolute: "at 3pm", "on Friday at 2pm", "December 31st at midnight"
- Recurring: "every day", "every Monday", "every 2 hours"
- Complex: "every weekday at 9am", "first Monday of each month"

## Job Persistence

All scheduled jobs are stored in MongoDB and survive:
- Agent restarts
- Server reboots
- PM2 restarts
- Crashes

Jobs are automatically resumed when the agent starts up.

## Monitoring Scheduled Jobs

Check scheduled jobs via:
- Web UI: Background Tasks page
- API: GET /api/scheduler/jobs
- Natural language: "show me scheduled jobs"
- Direct query: `this.scheduler.agenda.jobs({})`

## Best Practices

1. **Use descriptive job names** - Makes monitoring easier
2. **Include userId in job data** - For user-specific tasks
3. **Set appropriate intervals** - Avoid scheduling too frequently
4. **Handle job failures** - Jobs can define retry logic
5. **Clean up completed jobs** - Use the reminder cleanup pattern
6. **Test scheduling** - Verify jobs run at expected times

## Error Handling

Failed jobs are logged and can be configured to:
- Retry automatically
- Send error notifications
- Mark as failed and skip
- Escalate to admin

The agent monitors job execution and can alert on failures.