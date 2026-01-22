/**
 * @file AvailabilityService.ts
 * @brief Service for generating and saving availability summaries
 *
 * @description
 * This service extracts events from a date range, anonymizes them,
 * calculates available time slots, and generates markdown files
 * for sharing availability.
 */

import { DateTime } from 'luxon';
import { App, Notice, TFile } from 'obsidian';
import type { CachedEvent, OFCEventSource } from '../../core/EventCache';
import type { OFCEvent } from '../../types';
import type { FullCalendarSettings } from '../../types/settings';

/**
 * Anonymized event with only date/time information
 */
interface AnonymizedEvent {
  date: string; // ISO date string
  endDate: string | null;
  startTime: string | null;
  endTime: string | null;
  allDay: boolean;
}

/**
 * Time slot representing available time
 */
interface TimeSlot {
  date: string; // ISO date string (YYYY-MM-DD)
  startTime: string; // HH:mm format
  endTime: string; // HH:mm format
}

/**
 * Service for generating availability summaries
 */
export class AvailabilityService {
  private app: App;
  private settings: FullCalendarSettings;

  constructor(app: App, settings: FullCalendarSettings) {
    this.app = app;
    this.settings = settings;
  }

  /**
   * Get events in the specified date range from all visible calendars
   */
  getEventsInDateRange(
    sources: OFCEventSource[],
    startDate: Date,
    endDate: Date
  ): CachedEvent[] {
    const events: CachedEvent[] = [];
    const start = DateTime.fromJSDate(startDate).startOf('day');
    const end = DateTime.fromJSDate(endDate).endOf('day');

    for (const source of sources) {
      for (const cachedEvent of source.events) {
        const event = cachedEvent.event;
        if (this.eventOverlapsRange(event, start, end)) {
          events.push(cachedEvent);
        }
      }
    }

    return events;
  }

  /**
   * Check if an event overlaps with the given date range
   */
  private eventOverlapsRange(
    event: OFCEvent,
    rangeStart: DateTime,
    rangeEnd: DateTime
  ): boolean {
    if (event.type === 'single') {
      return this.singleEventOverlaps(event, rangeStart, rangeEnd);
    } else if (event.type === 'recurring') {
      return this.recurringEventOverlaps(event, rangeStart, rangeEnd);
    } else if (event.type === 'rrule') {
      return this.rruleEventOverlaps(event, rangeStart, rangeEnd);
    }
    return false;
  }

  /**
   * Check if a single event overlaps with the range
   */
  private singleEventOverlaps(
    event: OFCEvent,
    rangeStart: DateTime,
    rangeEnd: DateTime
  ): boolean {
    if (event.type !== 'single') return false;

    const eventStart = DateTime.fromISO(event.date).startOf('day');
    const eventEnd = event.endDate
      ? DateTime.fromISO(event.endDate).endOf('day')
      : eventStart.endOf('day');

    return eventStart <= rangeEnd && eventEnd >= rangeStart;
  }

  /**
   * Check if a recurring event overlaps with the range
   */
  private recurringEventOverlaps(
    event: OFCEvent,
    rangeStart: DateTime,
    rangeEnd: DateTime
  ): boolean {
    if (event.type !== 'recurring') return false;

    const startRecur = event.startRecur
      ? DateTime.fromISO(event.startRecur).startOf('day')
      : null;
    const endRecur = event.endRecur
      ? DateTime.fromISO(event.endRecur).endOf('day')
      : null;

    // If no startRecur, event doesn't have valid recurrence
    if (!startRecur) return false;

    // Check if recurrence period overlaps with range
    const recurrenceEnd = endRecur || DateTime.fromMillis(Number.MAX_SAFE_INTEGER);
    if (startRecur > rangeEnd || recurrenceEnd < rangeStart) {
      return false;
    }

    // For simplicity, we'll include recurring events if the recurrence period overlaps
    // The actual instances will be calculated during anonymization
    return true;
  }

  /**
   * Check if an rrule event overlaps with the range
   */
  private rruleEventOverlaps(
    event: OFCEvent,
    rangeStart: DateTime,
    rangeEnd: DateTime
  ): boolean {
    if (event.type !== 'rrule') return false;

    const startDate = DateTime.fromISO(event.startDate).startOf('day');
    // For rrule, we check if start date is within range or if the rule might generate instances
    // This is a simplified check - full rrule parsing would be more accurate
    return startDate <= rangeEnd;
  }

  /**
   * Anonymize an event by removing sensitive information
   */
  anonymizeEvent(event: CachedEvent): AnonymizedEvent {
    const ofcEvent = event.event;

    return {
      date: ofcEvent.type === 'single' ? ofcEvent.date : ofcEvent.type === 'rrule' ? ofcEvent.startDate : '',
      endDate:
        ofcEvent.type === 'single'
          ? ofcEvent.endDate
          : ofcEvent.type === 'rrule'
            ? ofcEvent.endDate
            : ofcEvent.endDate,
      startTime: ofcEvent.allDay ? null : ofcEvent.startTime || null,
      endTime: ofcEvent.allDay ? null : ofcEvent.endTime || null,
      allDay: ofcEvent.allDay || false
    };
  }

  /**
   * Expand recurring events into individual instances for the date range
   */
  private expandRecurringEvents(
    events: CachedEvent[],
    startDate: DateTime,
    endDate: DateTime
  ): AnonymizedEvent[] {
    const anonymized: AnonymizedEvent[] = [];

    for (const cachedEvent of events) {
      const event = cachedEvent.event;
      const anonymizedBase = this.anonymizeEvent(cachedEvent);

      if (event.type === 'single') {
        anonymized.push(anonymizedBase);
      } else if (event.type === 'recurring') {
        const instances = this.expandRecurringEvent(event, startDate, endDate);
        anonymized.push(...instances);
      } else if (event.type === 'rrule') {
        // For rrule events, we'll include them as single instances for simplicity
        // A full implementation would parse the rrule string
        if (anonymizedBase.date) {
          anonymized.push(anonymizedBase);
        }
      }
    }

    return anonymized;
  }

  /**
   * Expand a recurring event into individual instances
   */
  private expandRecurringEvent(
    event: OFCEvent,
    startDate: DateTime,
    endDate: DateTime
  ): AnonymizedEvent[] {
    if (event.type !== 'recurring') return [];

    const startRecur = event.startRecur
      ? DateTime.fromISO(event.startRecur).startOf('day')
      : null;
    const endRecur = event.endRecur
      ? DateTime.fromISO(event.endRecur).endOf('day')
      : null;

    if (!startRecur) return [];

    const effectiveStart = startRecur > startDate ? startRecur : startDate;
    const effectiveEnd = endRecur && endRecur < endDate ? endRecur : endDate;

    if (effectiveStart > effectiveEnd) return [];

    const instances: AnonymizedEvent[] = [];
    const skipDates = new Set(event.skipDates || []);

    // Handle weekly recurring events
    if (event.daysOfWeek && event.daysOfWeek.length > 0) {
      const dayMap: Record<string, number> = {
        U: 0, // Sunday
        M: 1, // Monday
        T: 2, // Tuesday
        W: 3, // Wednesday
        R: 4, // Thursday
        F: 5, // Friday
        S: 6 // Saturday
      };

      const targetDays = event.daysOfWeek.map(d => dayMap[d]).filter(d => d !== undefined);
      let current = effectiveStart;

      while (current <= effectiveEnd) {
        // Convert Luxon weekday (1=Monday, 7=Sunday) to our dayMap (0=Sunday, 1=Monday)
        const luxonWeekday = current.weekday; // 1-7
        const mappedWeekday = luxonWeekday === 7 ? 0 : luxonWeekday;
        
        if (targetDays.includes(mappedWeekday)) {
          const dateStr = current.toISODate();
          if (dateStr && !skipDates.has(dateStr)) {
            instances.push({
              date: dateStr,
              endDate: null,
              startTime: event.allDay ? null : event.startTime || null,
              endTime: event.allDay ? null : event.endTime || null,
              allDay: event.allDay || false
            });
          }
        }
        current = current.plus({ days: 1 });
      }
    } else {
      // For other recurrence types, include all days in range (simplified)
      let current = effectiveStart;
      while (current <= effectiveEnd) {
        const dateStr = current.toISODate();
        if (dateStr && !skipDates.has(dateStr)) {
          instances.push({
            date: dateStr,
            endDate: null,
            startTime: event.allDay ? null : event.startTime || null,
            endTime: event.allDay ? null : event.endTime || null,
            allDay: event.allDay || false
          });
        }
        current = current.plus({ days: 1 });
      }
    }

    return instances;
  }

  /**
   * Calculate available time slots from busy events
   */
  calculateAvailableSlots(
    busyEvents: AnonymizedEvent[],
    startDate: Date,
    endDate: Date
  ): TimeSlot[] {
    // Get business hours from settings, default to 9 AM - 5 PM
    const businessHours = this.settings.businessHours;
    const defaultStart = businessHours?.enabled && businessHours.startTime
      ? businessHours.startTime
      : '09:00';
    const defaultEnd = businessHours?.enabled && businessHours.endTime
      ? businessHours.endTime
      : '17:00';

    const availableSlots: TimeSlot[] = [];
    const start = DateTime.fromJSDate(startDate).startOf('day');
    const end = DateTime.fromJSDate(endDate).endOf('day');

    // Group busy events by date
    const busyByDate = new Map<string, AnonymizedEvent[]>();
    for (const event of busyEvents) {
      if (!busyByDate.has(event.date)) {
        busyByDate.set(event.date, []);
      } 
      busyByDate.get(event.date)!.push(event);
    }

    // For each day in range, calculate available slots
    let current = start;
    while (current <= end) {
      const dateStr = current.toISODate();
      if (!dateStr) {
        current = current.plus({ days: 1 });
        continue;
      }

      const dayBusyEvents = busyByDate.get(dateStr) || [];

      // Get busy time ranges for this day
      const busyRanges: Array<{ start: string; end: string }> = [];

      for (const event of dayBusyEvents) {
        if (event.allDay) {
          // All-day events block the entire day
          busyRanges.push({ start: '00:00', end: '23:59' });
        } else if (event.startTime && event.endTime) {
          busyRanges.push({ start: event.startTime, end: event.endTime });
        } else if (event.startTime) {
          // If only start time, assume 1 hour duration
          const startTime = DateTime.fromFormat(event.startTime, 'HH:mm');
          const endTime = startTime.plus({ hours: 1 });
          busyRanges.push({
            start: event.startTime,
            end: endTime.toFormat('HH:mm')
          });
        }
      }

      // Sort busy ranges by start time
      busyRanges.sort((a, b) => a.start.localeCompare(b.start));

      // Calculate available slots
      const daySlots = this.calculateDaySlots(busyRanges, defaultStart, defaultEnd);
      for (const slot of daySlots) {
        availableSlots.push({
          date: dateStr,
          startTime: slot.start,
          endTime: slot.end
        });
      }

      current = current.plus({ days: 1 });
    }

    return availableSlots;
  }

  /**
   * Calculate available slots for a single day
   */
  private calculateDaySlots(
    busyRanges: Array<{ start: string; end: string }>,
    dayStart: string,
    dayEnd: string
  ): Array<{ start: string; end: string }> {
    const slots: Array<{ start: string; end: string }> = [];

    if (busyRanges.length === 0) {
      // No busy events, entire day is available
      slots.push({ start: dayStart, end: dayEnd });
      return slots;
    }

    // Check if first busy event starts after day start
    if (busyRanges[0].start > dayStart) {
      slots.push({ start: dayStart, end: busyRanges[0].start });
    }

    // Find gaps between busy ranges
    for (let i = 0; i < busyRanges.length - 1; i++) {
      const currentEnd = busyRanges[i].end;
      const nextStart = busyRanges[i + 1].start;

      if (currentEnd < nextStart) {
        slots.push({ start: currentEnd, end: nextStart });
      }
    }

    // Check if last busy event ends before day end
    const lastBusyEnd = busyRanges[busyRanges.length - 1].end;
    if (lastBusyEnd < dayEnd) {
      slots.push({ start: lastBusyEnd, end: dayEnd });
    }

    return slots;
  }

  /**
   * Generate markdown content with availability summary
   */
  generateAvailabilityMarkdown(
    slots: TimeSlot[],
    startDate: Date,
    endDate: Date,
    workspaceName: string | null = null,
    calendarNames: string[] = []
  ): string {
    const start = DateTime.fromJSDate(startDate);
    const end = DateTime.fromJSDate(endDate);

    const lines: string[] = [];
    lines.push(`# Availability: ${start.toFormat('MMMM d')} - ${end.toFormat('MMMM d, yyyy')}`);
    lines.push('');
    
    // Add view/workspace information
    if (workspaceName) {
      lines.push(`This is an anonimized availability overview for workspace **${workspaceName}**`);
      lines.push('');
    }
    
    lines.push('---');
    
    // Group slots by date
    const slotsByDate = new Map<string, TimeSlot[]>();
    for (const slot of slots) {
      if (!slotsByDate.has(slot.date)) {
        slotsByDate.set(slot.date, []);
      }
      slotsByDate.get(slot.date)!.push(slot);
    }

    // Generate availability by day
    let current = start.startOf('day');
    while (current <= end.endOf('day')) {
      const dateStr = current.toISODate();
      if (!dateStr) {
        current = current.plus({ days: 1 });
        continue;
      }

      const daySlots = slotsByDate.get(dateStr) || [];

      if (daySlots.length > 0) {
        const dayName = current.toFormat('EEEE, MMMM d');
        const timeRanges = daySlots
          .map(slot => {
            const startTime = this.formatTime(slot.startTime);
            const endTime = this.formatTime(slot.endTime);
            return `${startTime} - ${endTime}`;
          })
          .join(', ');

        lines.push(`**${dayName}:** ${timeRanges}`);
      }

      current = current.plus({ days: 1 });
    }

    if (slots.length === 0) {
      lines.push('*No available time slots in this period.*');
    }

    return lines.join('\n');
  }

  /**
   * Format time string (HH:mm) to readable format (h:mm AM/PM)
   */
  private formatTime(timeStr: string): string {
    const [hours, minutes] = timeStr.split(':').map(Number);
    const date = DateTime.fromObject({ hour: hours, minute: minutes });
    return date.toFormat('h:mm a');
  }

  /**
   * Ensure the availability folder exists
   */
  private async ensureFolderExists(folderPath: string): Promise<void> {
    const folder = this.app.vault.getAbstractFileByPath(folderPath);

    if (!folder) {
      await this.app.vault.createFolder(folderPath);
    }
  }

  /**
   * Save availability file to vault
   */
  async saveAvailabilityFile(
    content: string,
    startDate: Date,
    endDate: Date
  ): Promise<string> {
    const folderPath = this.settings.availabilityFolder || 'Shared availability';
    await this.ensureFolderExists(folderPath);

    const start = DateTime.fromJSDate(startDate);
    const end = DateTime.fromJSDate(endDate);

    const startDateStr = start.toFormat('yyyy-MM-dd');
    const endDateStr = end.toFormat('yyyy-MM-dd');
    const filename = `${startDateStr}-availability-overview.md`;
    const filePath = `${folderPath}/${filename}`;

    // Check if file exists, append number if needed
    let finalPath = filePath;
    let counter = 1;
    while (this.app.vault.getAbstractFileByPath(finalPath)) {
      const baseName = filename.replace('.md', '');
      finalPath = `${folderPath}/${baseName}-${counter}.md`;
      counter++;
    }

    await this.app.vault.create(finalPath, content);
    return finalPath;
  }

  /**
   * Main method to generate and save availability
   */
  async generateAndSaveAvailability(
    sources: OFCEventSource[],
    startDate: Date,
    endDate: Date,
    workspaceName: string | null = null,
    calendarNames: string[] = []
  ): Promise<string> {
    // Get events in range
    const events = this.getEventsInDateRange(sources, startDate, endDate);

    // Expand recurring events
    const start = DateTime.fromJSDate(startDate);
    const end = DateTime.fromJSDate(endDate);
    const anonymizedEvents = this.expandRecurringEvents(events, start, end);

    // Calculate available slots
    const availableSlots = this.calculateAvailableSlots(anonymizedEvents, startDate, endDate);

    // Generate markdown
    const markdown = this.generateAvailabilityMarkdown(
      availableSlots,
      startDate,
      endDate,
      workspaceName,
      calendarNames
    );

    // Save file
    const filePath = await this.saveAvailabilityFile(markdown, startDate, endDate);

    return filePath;
  }
}
