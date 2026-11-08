/**
 * Group Recap Service
 *
 * Posts a light-hearted weekly message to one WhatsApp group, once per
 * calendar week (Monday-Sunday) on a random day and time inside an admin
 * chosen window:
 *
 * - When people made requests since the last post, the LLM writes a playful
 *   recap of them (titles and first names only).
 * - In a quiet week it writes a short movie/TV quip instead.
 * - If the LLM is off or fails, a plain recap template is sent; a quiet week
 *   with no LLM is skipped rather than posting something dull.
 *
 * Nothing new is stored: the recap is built from request_history. Config and
 * schedule state live in the settings table as JSON strings.
 *
 * Times use the server's local time zone, the same as broadcasts.
 *
 * @module services/group-recap/group-recap.service
 */

import { z } from 'zod';
import { settingRepository } from '../../repositories/setting.repository.js';
import { requestHistoryRepository } from '../../repositories/request-history.repository.js';
import { whatsappConnectionRepository } from '../../repositories/whatsapp-connection.repository.js';
import { whatsappClientService } from '../whatsapp/whatsapp-client.service.js';
import { llmService } from '../llm/llm.service.js';
import { logger } from '../../config/logger.js';
import type { RequestHistoryModel } from '../../models/request-history.model.js';

const CONFIG_KEY = 'groupRecap';
const STATE_KEY = 'groupRecapState';
const TICK_INTERVAL_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Never schedule a run closer than this to "now" */
const MIN_LEAD_MS = 10 * 60 * 1000;
/** Cap on requests listed to the model, to keep the prompt small */
const MAX_REQUESTS_IN_PROMPT = 40;
/** Failed sends before giving up on this week's slot */
const MAX_ATTEMPTS = 3;

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');

export const groupRecapConfigSchema = z
  .object({
    enabled: z.boolean(),
    groupJid: z
      .string()
      .regex(/^[\d-]+@g\.us$/, 'Pick a group')
      .nullable(),
    groupName: z.string().max(200).nullable(),
    brief: z.string().max(1000),
    windowStart: timeSchema,
    windowEnd: timeSchema,
  })
  .refine((c) => c.windowStart < c.windowEnd, {
    message: 'Window start must be before window end',
    path: ['windowEnd'],
  })
  .refine((c) => !c.enabled || c.groupJid !== null, {
    message: 'Pick a group before enabling the recap',
    path: ['groupJid'],
  });

export type GroupRecapConfig = z.infer<typeof groupRecapConfigSchema>;

export interface GroupRecapState {
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastResult: string | null;
  /** Consecutive failed attempts at the current slot */
  failures?: number;
}

export type RecapKind = 'recap' | 'quip' | 'template' | 'skip';

export interface RecapDraft {
  kind: RecapKind;
  text: string | null;
  requestCount: number;
}

export const DEFAULT_CONFIG: GroupRecapConfig = {
  enabled: false,
  groupJid: null,
  groupName: null,
  brief: '',
  windowStart: '11:00',
  windowEnd: '21:00',
};

const DEFAULT_STATE: GroupRecapState = { nextRunAt: null, lastRunAt: null, lastResult: null };

// ---------------------------------------------------------------------------
// Scheduling (pure, exported for tests)
// ---------------------------------------------------------------------------

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Whether `d` falls inside the daily window (local time) */
export function isWithinWindow(d: Date, windowStart: string, windowEnd: string): boolean {
  const m = d.getHours() * 60 + d.getMinutes();
  return m >= minutesOf(windowStart) && m < minutesOf(windowEnd);
}

/** Local midnight of the Monday of the week containing `d` */
export function startOfWeek(d: Date): Date {
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const offset = (s.getDay() + 6) % 7; // Monday = 0
  s.setDate(s.getDate() - offset);
  return s;
}

/**
 * Pick a random moment in a week, inside the daily window and after
 * `notBefore`. Returns null if no part of that week qualifies.
 */
function randomSlotInWeek(
  weekStart: Date,
  notBefore: Date,
  windowStart: string,
  windowEnd: string,
  rng: () => number
): Date | null {
  const startMin = minutesOf(windowStart);
  const endMin = minutesOf(windowEnd);

  const slots: { from: number; to: number }[] = [];
  for (let i = 0; i < 7; i++) {
    const day = new Date(weekStart);
    day.setDate(weekStart.getDate() + i);
    const from = new Date(day).setHours(0, startMin, 0, 0);
    const to = new Date(day).setHours(0, endMin, 0, 0);
    const clampedFrom = Math.max(from, notBefore.getTime());
    if (clampedFrom < to) slots.push({ from: clampedFrom, to });
  }

  if (slots.length === 0) return null;

  // Each remaining day is equally likely; then any minute within it
  const slot = slots[Math.min(slots.length - 1, Math.floor(rng() * slots.length))];
  const at = slot.from + Math.floor(rng() * (slot.to - slot.from));
  const result = new Date(at);
  result.setSeconds(0, 0);
  return result.getTime() < slot.from ? new Date(slot.from) : result;
}

/**
 * When the next recap should go out: a random day and time this week if
 * nothing has been posted this week yet, otherwise next week.
 */
export function computeNextRun(
  now: Date,
  lastRunAt: Date | null,
  windowStart: string,
  windowEnd: string,
  rng: () => number = Math.random
): Date {
  const notBefore = new Date(now.getTime() + MIN_LEAD_MS);
  const thisWeek = startOfWeek(now);

  const postedThisWeek = lastRunAt !== null && lastRunAt.getTime() >= thisWeek.getTime();
  if (!postedThisWeek) {
    const slot = randomSlotInWeek(thisWeek, notBefore, windowStart, windowEnd, rng);
    if (slot) return slot;
  }

  const nextWeek = new Date(thisWeek);
  nextWeek.setDate(thisWeek.getDate() + 7);
  // A full week with a valid window always has a slot
  return randomSlotInWeek(nextWeek, notBefore, windowStart, windowEnd, rng) as Date;
}

// ---------------------------------------------------------------------------
// Message building (exported for tests)
// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<string, string> = {
  SUBMITTED: 'added',
  APPROVED: 'approved',
  PENDING: 'waiting for approval',
  REJECTED: 'turned down',
  FAILED: 'failed',
};

/** First name only: the group doesn't need surnames, and neither does the LLM */
function firstName(name: string | null | undefined): string {
  const first = (name ?? '').trim().split(/\s+/)[0];
  return first || 'Someone';
}

function describeSeasons(seasons: unknown): string {
  if (!Array.isArray(seasons) || seasons.length === 0) return '';
  const nums = seasons.filter((n): n is number => typeof n === 'number').sort((a, b) => a - b);
  if (nums.length === 0) return '';
  if (nums.length === 1) return `season ${nums[0]}`;
  const contiguous = nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);
  return contiguous ? `seasons ${nums[0]}-${nums[nums.length - 1]}` : `seasons ${nums.join(', ')}`;
}

export function describeRequest(r: RequestHistoryModel): string {
  const title = r.year ? `${r.title} (${r.year})` : r.title;
  const kind = r.mediaType === 'series' ? 'show' : 'movie';
  const seasons = describeSeasons(r.selectedSeasons);
  const status = STATUS_LABELS[r.status] ?? r.status.toLowerCase();
  return `${firstName(r.contactName)} requested ${title} [${kind}${seasons ? `, ${seasons}` : ''}] - ${status}`;
}

const RULES = `Rules:
- Write for WhatsApp: plain text, *bold* and _italic_ allowed, a few emoji at most, no headings, no hashtags, no links.
- Only mention people and titles that appear in this week's requests or in the admin's brief. Never invent requests, people or stats, and never claim someone requested something unless it is in this week's requests.
- Tease gently, never mean, nothing crude, nothing about anyone's personal life.
- Reply with the message only - no preamble, no quotes around it.`;

function briefBlock(brief: string): string {
  const trimmed = brief.trim();
  return trimmed
    ? `\n\nThe group admin's brief (follow it for tone, topics and style, as long as it does not conflict with the rules):\n"""\n${trimmed}\n"""`
    : '';
}

/** How people reach the bot, so the nudge tells them the right thing to type */
export interface RequestHow {
  /** The connection's message filter value, e.g. "Plex" */
  trigger: string | null;
  /** prefix = must start the message, case-sensitive; keyword = anywhere, any case */
  mode: 'prefix' | 'keyword' | null;
  /** Whether the bot answers in groups (otherwise people must DM it) */
  inGroup: boolean;
}

const NO_TRIGGER: RequestHow = { trigger: null, mode: null, inGroup: false };

function howToRequest(how: RequestHow): string {
  const where = how.inGroup
    ? 'They can type it right here in this group.'
    : 'They have to send it to the bot in a private chat - typing it in this group does nothing.';

  if (!how.trigger) {
    return `People request things by sending the bot a title. ${where}`;
  }

  const example = `${how.trigger} Dune`;
  const exact =
    how.mode === 'prefix'
      ? `The message must start with "${how.trigger}" spelled exactly like that, with the same capitalisation, followed by a title (e.g. "${example}"). Any other spelling or capitalisation is ignored, so always write it exactly as "${how.trigger}".`
      : `The message must contain the word "${how.trigger}" and a title (e.g. "${example}").`;

  return `People request things with a command. ${exact} ${where} "${how.trigger}" here is just the bot's command word - do not treat it as an app, service or place to watch things (never write things like "watch it on ${how.trigger}").`;
}

/** The one-line nudge for the plain template */
export function templateNudge(how: RequestHow): string {
  const where = how.inGroup ? 'here' : 'to me in a private chat';
  return how.trigger
    ? `Want something? Send "${how.trigger} <title>" ${where}.`
    : `Want something? Send me a title ${where}.`;
}

export function buildRecapPrompts(
  requests: RequestHistoryModel[],
  brief: string,
  how: RequestHow = NO_TRIGGER
): { system: string; user: string } {
  const lines = requests.slice(0, MAX_REQUESTS_IN_PROMPT).map((r) => `- ${describeRequest(r)}`);
  const more = requests.length - lines.length;

  return {
    system: `You write the weekly recap for a WhatsApp group of friends and family who share a home media server. A bot called WAMR takes their movie and TV requests.
Write a short, funny recap of this week's requests (aim for 60-120 words). Celebrate what got added, gently roast questionable picks or repeat offenders, and end with a one-line nudge to request something that shows exactly what to type. ${howToRequest(how)}

${RULES}${briefBlock(brief)}`,
    user: `This week's requests (${requests.length} total):\n${lines.join('\n')}${more > 0 ? `\n...and ${more} more` : ''}`,
  };
}

export function buildQuipPrompts(
  brief: string,
  how: RequestHow = NO_TRIGGER
): { system: string; user: string } {
  return {
    system: `You post in a WhatsApp group of friends and family who share a home media server run by a bot called WAMR.
Nobody requested anything this week. Write one short, funny message about movies or TV to liven the group up (under 60 words): a quip, a hot-take question, a "would you rather", or a playful nudge that the server is feeling ignored. If you mention requesting, show exactly what to type. ${howToRequest(how)}

${RULES}${briefBlock(brief)}`,
    user: "Write this week's message.",
  };
}

/** Plain recap used when the LLM is off or fails */
export function buildTemplateRecap(
  requests: RequestHistoryModel[],
  how: RequestHow = NO_TRIGGER
): string {
  const shown = requests.slice(0, 15);
  const lines = shown.map((r) => {
    const title = r.year ? `${r.title} (${r.year})` : r.title;
    return `• ${title} - ${firstName(r.contactName)}`;
  });
  const more = requests.length - shown.length;
  const plural = requests.length === 1 ? 'request' : 'requests';
  const nudge = templateNudge(how);

  return [
    `🎬 *Weekly recap* - ${requests.length} ${plural} this week`,
    '',
    ...lines,
    ...(more > 0 ? [`…and ${more} more`] : []),
    '',
    nudge,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class GroupRecapService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start(): void {
    // onReady fires on every reconnect; only ever run one ticker
    if (this.timer) return;
    this.tick().catch((e) => logger.error({ error: e }, 'Group recap initial tick failed'));
    this.timer = setInterval(() => {
      this.tick().catch((e) => logger.error({ error: e }, 'Group recap tick failed'));
    }, TICK_INTERVAL_MS);
    logger.info('Group recap scheduler started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async getConfig(): Promise<GroupRecapConfig> {
    return this.readJson(CONFIG_KEY, DEFAULT_CONFIG, groupRecapConfigSchema);
  }

  async getState(): Promise<GroupRecapState> {
    return this.readJson(STATE_KEY, DEFAULT_STATE);
  }

  /**
   * Save config and (re)schedule. Changing the group or window, or turning
   * the recap on, picks a fresh random slot; turning it off clears it.
   */
  async saveConfig(
    config: GroupRecapConfig
  ): Promise<{ config: GroupRecapConfig; state: GroupRecapState }> {
    const previous = await this.getConfig();
    const state = await this.getState();

    await settingRepository.upsert({ key: CONFIG_KEY, value: JSON.stringify(config) });

    const scheduleChanged =
      !previous.enabled ||
      previous.groupJid !== config.groupJid ||
      previous.windowStart !== config.windowStart ||
      previous.windowEnd !== config.windowEnd ||
      !state.nextRunAt;

    if (!config.enabled) {
      state.nextRunAt = null;
    } else if (scheduleChanged) {
      state.nextRunAt = this.scheduleFrom(state, config).toISOString();
    }

    await this.writeState(state);
    logger.info(
      { enabled: config.enabled, nextRunAt: state.nextRunAt },
      'Group recap config saved'
    );
    return { config, state };
  }

  /** Generate this week's message without sending it */
  async preview(brief?: string): Promise<RecapDraft> {
    const saved = await this.getConfig();
    // Lets the admin try out a brief before saving it
    const config = brief === undefined ? saved : { ...saved, brief };
    const state = await this.getState();
    return this.draft(config, state, new Date());
  }

  /**
   * Post now, outside the schedule. Doesn't change the weekly slot, so the
   * scheduled recap still goes out (covering anything requested since).
   */
  async sendNow(): Promise<RecapDraft> {
    const config = await this.getConfig();
    if (!config.groupJid) {
      throw new Error('No group selected');
    }

    const state = await this.getState();
    const now = new Date();
    const draft = await this.draft(config, state, now);

    if (draft.text) {
      await whatsappClientService.sendMessage(config.groupJid, draft.text);
      state.lastRunAt = now.toISOString();
      state.lastResult = `Sent manually (${draft.kind})`;
      await this.writeState(state);
    }

    return draft;
  }

  /** Exposed for tests; normally driven by the interval */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;

    let config: GroupRecapConfig | null = null;
    let state: GroupRecapState | null = null;
    const now = new Date();

    try {
      config = await this.getConfig();
      state = await this.getState();
      if (!config.enabled || !config.groupJid || !state.nextRunAt) return;
      if (new Date(state.nextRunAt).getTime() > now.getTime()) return;

      // Overdue because the server or WhatsApp was down: don't post at 3am,
      // pick a fresh slot inside the window instead
      if (!isWithinWindow(now, config.windowStart, config.windowEnd)) {
        const lastRun = state.lastRunAt ? new Date(state.lastRunAt) : null;
        state.nextRunAt = computeNextRun(
          now,
          lastRun,
          config.windowStart,
          config.windowEnd
        ).toISOString();
        await this.writeState(state);
        logger.info({ nextRunAt: state.nextRunAt }, 'Group recap missed its slot, rescheduled');
        return;
      }

      // Wait for WhatsApp rather than burn the week's slot while offline
      if (!whatsappClientService.isReady()) {
        logger.info('Group recap due but WhatsApp is not ready, will retry');
        return;
      }

      const draft = await this.draft(config, state, now);

      if (draft.text) {
        await whatsappClientService.sendMessage(config.groupJid, draft.text);
        state.lastResult = `Sent (${draft.kind}, ${draft.requestCount} requests)`;
        logger.info({ kind: draft.kind, requestCount: draft.requestCount }, 'Group recap sent');
      } else {
        state.lastResult = 'Skipped: quiet week and the LLM is unavailable';
        logger.info('Group recap skipped: quiet week and no LLM');
      }

      state.lastRunAt = now.toISOString();
      state.failures = 0;
      state.nextRunAt = computeNextRun(
        now,
        now,
        config.windowStart,
        config.windowEnd
      ).toISOString();
      await this.writeState(state);
    } catch (error) {
      logger.error({ error }, 'Group recap failed');

      if (!config || !state) return;

      // Retry on the next ticks, but give up for the week after a few tries
      // (e.g. WAMR was removed from the group) instead of retrying forever
      state.failures = (state.failures ?? 0) + 1;
      const reason = error instanceof Error ? error.message : String(error);
      if (state.failures >= MAX_ATTEMPTS) {
        state.failures = 0;
        state.lastResult = `Failed ${MAX_ATTEMPTS} times (${reason}); will try again next week`;
        // lastRunAt is left alone, so next week's recap still covers these requests
        state.nextRunAt = computeNextRun(
          now,
          now,
          config.windowStart,
          config.windowEnd
        ).toISOString();
      } else {
        state.lastResult = `Failed (${reason}); retrying`;
      }
      await this.writeState(state).catch(() => undefined);
    } finally {
      this.running = false;
    }
  }

  private async draft(
    config: GroupRecapConfig,
    state: GroupRecapState,
    now: Date
  ): Promise<RecapDraft> {
    const since = state.lastRunAt
      ? new Date(state.lastRunAt)
      : new Date(now.getTime() - 7 * DAY_MS);
    const requests = await requestHistoryRepository.findCreatedBetween(
      since.toISOString(),
      now.toISOString()
    );
    const how = await this.requestHow();

    if (requests.length > 0) {
      const { system, user } = buildRecapPrompts(requests, config.brief, how);
      const text = await llmService.generateText(system, user);
      return text
        ? { kind: 'recap', text, requestCount: requests.length }
        : {
            kind: 'template',
            text: buildTemplateRecap(requests, how),
            requestCount: requests.length,
          };
    }

    const { system, user } = buildQuipPrompts(config.brief, how);
    const text = await llmService.generateText(system, user);
    return text
      ? { kind: 'quip', text, requestCount: 0 }
      : { kind: 'skip', text: null, requestCount: 0 };
  }

  private scheduleFrom(state: GroupRecapState, config: GroupRecapConfig): Date {
    const lastRun = state.lastRunAt ? new Date(state.lastRunAt) : null;
    return computeNextRun(new Date(), lastRun, config.windowStart, config.windowEnd);
  }

  /** What people type, and where, for the "request something" nudge */
  private async requestHow(): Promise<RequestHow> {
    try {
      const conn = await whatsappConnectionRepository.getFirst();
      const trigger = conn?.filterType && conn.filterValue ? conn.filterValue : null;
      return {
        trigger,
        mode: trigger ? (conn?.filterType ?? null) : null,
        inGroup: conn?.processGroups ?? false,
      };
    } catch {
      return NO_TRIGGER;
    }
  }

  private async writeState(state: GroupRecapState): Promise<void> {
    await settingRepository.upsert({ key: STATE_KEY, value: JSON.stringify(state) });
  }

  private async readJson<T>(key: string, fallback: T, schema?: z.ZodType<T>): Promise<T> {
    try {
      const row = await settingRepository.findByKey(key);
      if (typeof row?.value !== 'string') return { ...fallback };
      const parsed = { ...fallback, ...JSON.parse(row.value) };
      if (!schema) return parsed;
      const result = schema.safeParse(parsed);
      return result.success ? result.data : { ...fallback };
    } catch (error) {
      logger.warn({ error, key }, 'Could not read group recap setting, using defaults');
      return { ...fallback };
    }
  }
}

export const groupRecapService = new GroupRecapService();
