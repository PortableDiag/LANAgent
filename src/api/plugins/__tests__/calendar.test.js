import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import CalendarPlugin from '../calendar.js';

describe('CalendarPlugin', () => {
  let plugin;
  let mockAgent;
  
  beforeEach(() => {
    mockAgent = {
      config: { name: 'TestAgent' },
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
      },
      memoryManager: {
        store: jest.fn(),
        recall: jest.fn()
      },
      systemExecutor: {
        execute: jest.fn()
      },
      interfaces: new Map(),
      services: new Map()
    };
    
    plugin = new CalendarPlugin(mockAgent);
  });
  
  describe('initialization', () => {
    test('initializes with correct metadata', () => {
      expect(plugin.name).toBe('calendar');
      expect(plugin.version).toBe('1.0.0');
      expect(plugin.description).toContain('CalDAV');
    });
    
    test('warns when credentials not configured', async () => {
      await plugin.initialize();
      expect(mockAgent.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Calendar credentials not configured')
      );
    });
  });
  
  describe('execute', () => {
    test('validates required action parameter', async () => {
      await expect(plugin.execute({})).rejects.toThrow('action is required');
    });
    
    test('rejects unknown actions', async () => {
      await expect(
        plugin.execute({ action: 'unknownAction' })
      ).rejects.toThrow('action must be one of');
    });
    
    test('requires connection for most actions', async () => {
      const result = await plugin.execute({ action: 'listCalendars' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not connected');
    });
  });
  
  describe('setCredentials', () => {
    test('validates required parameters', async () => {
      await expect(
        plugin.execute({ action: 'setCredentials' })
      ).rejects.toThrow('username is required');
      
      await expect(
        plugin.execute({ 
          action: 'setCredentials',
          username: 'test@example.com'
        })
      ).rejects.toThrow('password is required');
    });
    
    test('auto-detects Google Calendar server', () => {
      const url = plugin.getServerUrl('user@gmail.com');
      expect(url).toContain('google.com');
    });
    
    test('auto-detects iCloud server', () => {
      const url = plugin.getServerUrl('user@icloud.com');
      expect(url).toContain('caldav.icloud.com');
    });
  });
  
  describe('getCommands', () => {
    test('returns all available commands', () => {
      const commands = plugin.getCommands();
      expect(commands).toHaveProperty('setCredentials');
      expect(commands).toHaveProperty('listCalendars');
      expect(commands).toHaveProperty('getEvents');
      expect(commands).toHaveProperty('createEvent');
      expect(commands).toHaveProperty('checkAvailability');
      expect(Object.keys(commands).length).toBeGreaterThanOrEqual(10);
    });
  });
  
  describe('event parsing', () => {
    test('parses basic event data', () => {
      const icalData = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:test123@example.com
DTSTAMP:20231225T120000Z
DTSTART:20231226T140000Z
DTEND:20231226T150000Z
SUMMARY:Test Event
DESCRIPTION:This is a test event
LOCATION:Conference Room
END:VEVENT
END:VCALENDAR`;
      
      const parsed = plugin.parseICalEvent(icalData);
      expect(parsed).toBeTruthy();
      expect(parsed.title).toBe('Test Event');
      expect(parsed.description).toBe('This is a test event');
      expect(parsed.location).toBe('Conference Room');
    });
  });
});