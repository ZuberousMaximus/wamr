import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { settingsStore, mocks } = vi.hoisted(() => ({
  settingsStore: new Map<string, string>(),
  mocks: {
    findCreatedBetween: vi.fn(),
    getFirst: vi.fn(),
    isReady: vi.fn(),
    sendMessage: vi.fn(),
    generateText: vi.fn(),
  },
}));

vi.mock('../../../src/repositories/setting.repository.js', () => ({
  settingRepository: {
    findByKey: vi.fn(async (key: string) =>
      settingsStore.has(key) ? { key, value: settingsStore.get(key) } : null
    ),
    upsert: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      settingsStore.set(key, value);
      return { key, value };
    }),
  },
}));
vi.mock('../../../src/repositories/request-history.repository.js', () => ({
  requestHistoryRepository: { findCreatedBetween: mocks.findCreatedBetween },
}));
vi.mock('../../../src/repositories/whatsapp-connection.repository.js', () => ({
  whatsappConnectionRepository: { getFirst: mocks.getFirst },
}));
vi.mock('../../../src/services/whatsapp/whatsapp-client.service.js', () => ({
  whatsappClientService: { isReady: mocks.isReady, sendMessage: mocks.sendMessage },
}));
vi.mock('../../../src/services/llm/llm.service.js', () => ({
  llmService: { generateText: mocks.generateText },
}));

import {
  computeNextRun,
  startOfWeek,
  describeRequest,
  buildRecapPrompts,
  buildTemplateRecap,
  buildQuipPrompts,
  templateNudge,
  GroupRecapService,
  groupRecapConfigSchema,
  type GroupRecapConfig,
} from '../../../src/services/group-recap/group-recap.service.js';
import type { RequestHistoryModel } from '../../../src/models/request-history.model.js';

function req(overrides: Partial<RequestHistoryModel> = {}): RequestHistoryModel {
  return {
    id: 1,
    phoneNumberHash: 'hash',
    contactName: 'Sam Smith',
    mediaType: 'movie',
    title: 'Dune: Part Two',
    year: 2024,
    status: 'SUBMITTED',
    selectedSeasons: null,
    createdAt: '2026-11-03T10:00:00.000Z',
    ...overrides,
  } as RequestHistoryModel;
}

const enabledConfig: GroupRecapConfig = {
  enabled: true,
  groupJid: '120363000000000000@g.us',
  groupName: 'Movie Night',
  brief: 'Be extra dramatic.',
  windowStart: '11:00',
  windowEnd: '21:00',
};

describe('group recap scheduling', () => {
  // Wednesday 2026-11-04 12:00 local
  const wed = new Date(2026, 10, 4, 12, 0);

  it('starts weeks on Monday', () => {
    expect(startOfWeek(wed)).toEqual(new Date(2026, 10, 2));
    expect(startOfWeek(new Date(2026, 10, 8, 23))).toEqual(new Date(2026, 10, 2)); // Sunday
  });

  it('always lands inside the daily window', () => {
    for (let i = 0; i < 200; i++) {
      const next = computeNextRun(wed, null, '11:00', '21:00');
      const minutes = next.getHours() * 60 + next.getMinutes();
      expect(minutes).toBeGreaterThanOrEqual(11 * 60);
      expect(minutes).toBeLessThan(21 * 60);
      expect(next.getTime()).toBeGreaterThan(wed.getTime());
    }
  });

  it('uses the rest of this week when nothing was posted yet', () => {
    const next = computeNextRun(wed, null, '11:00', '21:00', () => 0);
    // Earliest slot: today, 10 minutes from now
    expect(next).toEqual(new Date(2026, 10, 4, 12, 10));
  });

  it('moves to next week once this week has had a recap', () => {
    const postedMonday = new Date(2026, 10, 2, 15, 0);
    const next = computeNextRun(wed, postedMonday, '11:00', '21:00', () => 0);
    expect(next).toEqual(new Date(2026, 10, 9, 11, 0)); // next Monday 11:00
  });

  it("rolls into next week when this week's window is already over", () => {
    const lateSunday = new Date(2026, 10, 8, 22, 0);
    const next = computeNextRun(lateSunday, null, '11:00', '21:00', () => 0.999);
    expect(startOfWeek(next)).toEqual(new Date(2026, 10, 9));
    expect(next.getDay()).toBe(0); // last day of that week
  });
});

describe('group recap config validation', () => {
  it('rejects enabling without a group', () => {
    const result = groupRecapConfigSchema.safeParse({ ...enabledConfig, groupJid: null });
    expect(result.success).toBe(false);
  });

  it('rejects a backwards window and non-group JIDs', () => {
    expect(
      groupRecapConfigSchema.safeParse({ ...enabledConfig, windowStart: '22:00' }).success
    ).toBe(false);
    expect(
      groupRecapConfigSchema.safeParse({
        ...enabledConfig,
        groupJid: '447700900000@s.whatsapp.net',
      }).success
    ).toBe(false);
  });

  it('caps the brief at 1000 characters', () => {
    expect(
      groupRecapConfigSchema.safeParse({ ...enabledConfig, brief: 'x'.repeat(1001) }).success
    ).toBe(false);
  });
});

describe('group recap message building', () => {
  it('uses first names only and describes seasons', () => {
    const line = describeRequest(
      req({
        mediaType: 'series',
        title: 'Severance',
        year: null,
        selectedSeasons: [1, 2, 3] as never,
      })
    );
    expect(line).toBe('Sam requested Severance [show, seasons 1-3] - added');
    expect(line).not.toContain('Smith');
  });

  it('puts the admin brief and exact-case prefix into the prompt', () => {
    const { system, user } = buildRecapPrompts([req()], 'Be extra dramatic.', {
      trigger: 'Plex',
      mode: 'prefix',
      inGroup: true,
    });
    expect(system).toContain('Be extra dramatic.');
    expect(system).toContain("this week's requests or in the admin's brief");
    expect(system).toContain('never claim someone requested something');
    expect(system).toContain('"Plex Dune"');
    expect(system).toContain('same capitalisation');
    expect(system).toContain('right here in this group');
    expect(system).toContain('never write things like "watch it on Plex"');
    expect(user).toContain('Sam requested Dune: Part Two (2024)');
  });

  it('tells people to DM the bot when it ignores groups', () => {
    const { system } = buildQuipPrompts('', { trigger: 'Plex', mode: 'prefix', inGroup: false });
    expect(system).toContain('private chat');
    expect(templateNudge({ trigger: 'Plex', mode: 'prefix', inGroup: false })).toBe(
      'Want something? Send "Plex <title>" to me in a private chat.'
    );
  });

  it('builds a plain template recap', () => {
    const text = buildTemplateRecap(
      [req(), req({ contactName: null, title: 'Cars 2', year: 2011 })],
      { trigger: 'Plex', mode: 'prefix', inGroup: true }
    );
    expect(text).toContain('2 requests this week');
    expect(text).toContain('• Cars 2 (2011) - Someone');
    expect(text.endsWith('Want something? Send "Plex <title>" here.')).toBe(true);
  });
});

describe('GroupRecapService', () => {
  let service: GroupRecapService;

  beforeEach(() => {
    vi.clearAllMocks();
    settingsStore.clear();
    mocks.getFirst.mockResolvedValue({
      filterType: 'prefix',
      filterValue: 'Plex',
      processGroups: true,
    });
    mocks.isReady.mockReturnValue(true);
    mocks.sendMessage.mockResolvedValue('msg-id');
    service = new GroupRecapService();
  });

  it('schedules on enable and clears on disable', async () => {
    const { state } = await service.saveConfig(enabledConfig);
    expect(state.nextRunAt).not.toBeNull();

    const off = await service.saveConfig({ ...enabledConfig, enabled: false });
    expect(off.state.nextRunAt).toBeNull();
  });

  it('writes an LLM recap when there were requests', async () => {
    mocks.findCreatedBetween.mockResolvedValue([req()]);
    mocks.generateText.mockResolvedValue('Sam finally got Dune 🏜️');
    await service.saveConfig(enabledConfig);

    const draft = await service.preview();
    expect(draft).toEqual({ kind: 'recap', text: 'Sam finally got Dune 🏜️', requestCount: 1 });
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('falls back to the template when the LLM fails', async () => {
    mocks.findCreatedBetween.mockResolvedValue([req()]);
    mocks.generateText.mockResolvedValue(null);
    await service.saveConfig(enabledConfig);

    const draft = await service.preview();
    expect(draft.kind).toBe('template');
    expect(draft.text).toContain('Dune: Part Two');
    expect(draft.text).toContain('Send "Plex <title>" here.');
  });

  it('writes a quip in a quiet week, and skips if the LLM is unavailable', async () => {
    mocks.findCreatedBetween.mockResolvedValue([]);
    await service.saveConfig(enabledConfig);

    mocks.generateText.mockResolvedValueOnce('Is Die Hard a Christmas movie? Discuss.');
    expect((await service.preview()).kind).toBe('quip');

    mocks.generateText.mockResolvedValueOnce(null);
    expect(await service.preview()).toEqual({ kind: 'skip', text: null, requestCount: 0 });
  });

  it('sends to the group and records the run', async () => {
    mocks.findCreatedBetween.mockResolvedValue([req()]);
    mocks.generateText.mockResolvedValue('Recap!');
    await service.saveConfig(enabledConfig);

    await service.sendNow();
    expect(mocks.sendMessage).toHaveBeenCalledWith(enabledConfig.groupJid, 'Recap!');
    expect((await service.getState()).lastRunAt).not.toBeNull();
  });

  it('falls back to defaults when the stored config is corrupt', async () => {
    settingsStore.set('groupRecap', '{not json');
    expect((await service.getConfig()).enabled).toBe(false);
  });

  describe('scheduled tick', () => {
    afterEach(() => vi.useRealTimers());

    async function dueAt(when: Date) {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(when.getTime() - 60 * 60 * 1000));
      await service.saveConfig(enabledConfig);
      settingsStore.set(
        'groupRecapState',
        JSON.stringify({ ...(await service.getState()), nextRunAt: when.toISOString() })
      );
      vi.setSystemTime(when);
    }

    it('sends when due inside the window and schedules next week', async () => {
      mocks.findCreatedBetween.mockResolvedValue([req()]);
      mocks.generateText.mockResolvedValue('Recap!');
      await dueAt(new Date(2026, 10, 4, 15, 0)); // Wednesday 15:00

      await service.tick();

      expect(mocks.sendMessage).toHaveBeenCalledWith(enabledConfig.groupJid, 'Recap!');
      const state = await service.getState();
      expect(startOfWeek(new Date(state.nextRunAt!))).toEqual(new Date(2026, 10, 9));
    });

    it('reschedules instead of posting when overdue outside the window', async () => {
      await dueAt(new Date(2026, 10, 4, 3, 0)); // Wednesday 03:00

      await service.tick();

      expect(mocks.sendMessage).not.toHaveBeenCalled();
      const next = new Date((await service.getState()).nextRunAt!);
      expect(next.getTime()).toBeGreaterThan(new Date(2026, 10, 4, 3, 0).getTime());
      expect(next.getHours()).toBeGreaterThanOrEqual(11);
    });

    it('gives up for the week after repeated send failures', async () => {
      mocks.findCreatedBetween.mockResolvedValue([req()]);
      mocks.generateText.mockResolvedValue('Recap!');
      mocks.sendMessage.mockRejectedValue(new Error('not a participant'));
      await dueAt(new Date(2026, 10, 4, 15, 0));

      await service.tick();
      await service.tick();
      expect((await service.getState()).lastResult).toContain('retrying');

      await service.tick();
      const state = await service.getState();
      expect(state.lastResult).toContain('try again next week');
      expect(state.lastRunAt).toBeNull();
      expect(startOfWeek(new Date(state.nextRunAt!))).toEqual(new Date(2026, 10, 9));
    });
  });
});
