import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConversationService } from '../../../src/services/conversation/conversation.service';
import { conversationSessionRepository } from '../../../src/repositories/conversation-session.repository';
import { mediaServiceConfigRepository } from '../../../src/repositories/media-service-config.repository';
import { stateMachine } from '../../../src/services/conversation/state-machine';
import { OverseerrClient } from '../../../src/services/integrations/overseerr.client';
import { encryptionService } from '../../../src/services/encryption/encryption.service';

vi.mock('../../../src/repositories/conversation-session.repository');
vi.mock('../../../src/repositories/whatsapp-connection.repository');
vi.mock('../../../src/repositories/media-service-config.repository');
vi.mock('../../../src/repositories/setting.repository');
vi.mock('../../../src/services/conversation/intent-parser');
vi.mock('../../../src/services/conversation/state-machine');
vi.mock('../../../src/services/media-search/media-search.service');
vi.mock('../../../src/services/conversation/request-approval.service');
vi.mock('../../../src/services/whatsapp/whatsapp-client.service');
vi.mock('../../../src/services/integrations/overseerr.client');
vi.mock('../../../src/services/encryption/encryption.service');
vi.mock('../../../src/config/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/**
 * Regression coverage for requesting further seasons of a show that is already
 * partially in the library. The show-level Overseerr status (4 = partially
 * available) must not block seasons that were never requested.
 */
describe('ConversationService — per-season availability', () => {
  let service: ConversationService;

  const show = {
    title: 'Severance',
    year: 2022,
    tmdbId: 95396,
    mediaType: 'series' as const,
    overview: 'Office drama',
    mediaStatus: 4,
  };

  const tvSeasons = [
    { id: 10, seasonNumber: 0, name: 'Specials', episodeCount: 2 },
    { id: 11, seasonNumber: 1, name: 'Season 1', episodeCount: 9 },
    { id: 12, seasonNumber: 2, name: 'Season 2', episodeCount: 10 },
    { id: 13, seasonNumber: 3, name: 'Season 3', episodeCount: 8 },
  ];

  const mockTvDetails = (mediaInfoSeasons: Array<{ seasonNumber: number; status: number }>) => {
    vi.mocked(OverseerrClient).mockImplementation(
      () =>
        ({
          getTvDetails: vi.fn().mockResolvedValue({
            id: show.tmdbId,
            name: show.title,
            overview: show.overview,
            seasons: tvSeasons,
            mediaInfo: {
              id: 1,
              tmdbId: show.tmdbId,
              status: show.mediaStatus,
              seasons: mediaInfoSeasons.map((s, i) => ({ id: i + 1, ...s })),
            },
          }),
        }) as any
    );
  };

  const selectionSession = (result = show) =>
    ({
      id: 'session-1',
      phoneNumberHash: 'hash',
      state: 'AWAITING_SELECTION',
      searchResults: [result],
      expiresAt: new Date().toISOString(),
    }) as any;

  const seasonSession = (availableSeasons: any[]) =>
    ({
      id: 'session-1',
      phoneNumberHash: 'hash',
      state: 'AWAITING_SEASON_SELECTION',
      selectedResult: show,
      availableSeasons,
      expiresAt: new Date().toISOString(),
    }) as any;

  const select = (session: any) =>
    (service as any).handleAwaitingSelection(session, { intent: 'selection', selectionNumber: 1 });

  const pickSeasons = (session: any, seasons: number[] | 'all') =>
    (service as any).handleAwaitingSeasonSelection(session, {
      intent: 'season_selection',
      seasons,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ConversationService();
    vi.mocked(mediaServiceConfigRepository.findByType).mockResolvedValue([
      { id: 1, enabled: true, baseUrl: 'http://seerr', apiKeyEncrypted: 'enc' } as any,
    ]);
    vi.mocked(encryptionService.decrypt).mockReturnValue('api-key');
    vi.mocked(stateMachine.processAction).mockReturnValue({ valid: true } as any);
    vi.mocked(conversationSessionRepository.update).mockResolvedValue(undefined as any);
  });

  describe('selecting a partially available show', () => {
    it('offers season selection instead of the "partially available" dead end', async () => {
      mockTvDetails([{ seasonNumber: 1, status: 5 }]);

      const result = await select(selectionSession());

      expect(result.state).toBe('AWAITING_SEASON_SELECTION');
      expect(result.message).not.toContain('is partially available — some content');
      expect(result.message).toContain('Which season(s) would you like to download?');
    });

    it('marks seasons that are already available or requested', async () => {
      mockTvDetails([
        { seasonNumber: 1, status: 5 },
        { seasonNumber: 2, status: 2 },
      ]);

      const result = await select(selectionSession());

      expect(result.message).toMatch(/Season 1: Season 1 \(9 episodes\) — ✅ available/);
      expect(result.message).toMatch(/Season 2: Season 2 \(10 episodes\) — ⏳ already requested/);
      expect(result.message).toMatch(/Season 3: Season 3 \(8 episodes\)\n/);
      expect(result.message).toContain('"all" for all remaining seasons');
    });

    it('stores each season with its Overseerr status and skips specials', async () => {
      mockTvDetails([{ seasonNumber: 1, status: 5 }]);

      await select(selectionSession());

      const update = vi.mocked(conversationSessionRepository.update).mock.calls[0][1];
      expect(update.availableSeasons).toEqual([
        expect.objectContaining({ seasonNumber: 1, status: 5 }),
        expect.objectContaining({ seasonNumber: 2, status: undefined }),
        expect.objectContaining({ seasonNumber: 3, status: undefined }),
      ]);
    });

    it('still blocks when every season is already available or requested', async () => {
      mockTvDetails([
        { seasonNumber: 1, status: 5 },
        { seasonNumber: 2, status: 5 },
        { seasonNumber: 3, status: 3 },
      ]);

      const result = await select(selectionSession());

      expect(result.state).toBe('AWAITING_SELECTION');
      expect(result.message).toContain('is partially available');
      expect(conversationSessionRepository.update).not.toHaveBeenCalled();
    });

    it('falls back to the show-level block when season details cannot be fetched', async () => {
      vi.mocked(mediaServiceConfigRepository.findByType).mockResolvedValue([]);

      const result = await select(selectionSession());

      expect(result.state).toBe('AWAITING_SELECTION');
      expect(result.message).toContain('is partially available');
    });

    it('lets an untouched show through with the plain season prompt', async () => {
      mockTvDetails([]);

      const result = await select(selectionSession({ ...show, mediaStatus: undefined as any }));

      expect(result.state).toBe('AWAITING_SEASON_SELECTION');
      expect(result.message).toContain('"all" for all seasons');
      expect(result.message).not.toContain('— ✅');
    });
  });

  describe('movies keep the existing block', () => {
    it.each([
      [2, 'pending approval'],
      [3, 'being processed'],
      [4, 'partially available'],
      [5, 'already available in the library'],
    ])('status %i → "%s"', async (mediaStatus, text) => {
      const movie = { title: 'Inception', year: 2010, mediaType: 'movie' as const, mediaStatus };

      const result = await select(selectionSession(movie as any));

      expect(result.state).toBe('AWAITING_SELECTION');
      expect(result.message).toContain(text);
      expect(OverseerrClient).not.toHaveBeenCalled();
    });
  });

  describe('choosing seasons', () => {
    const seasons = [
      { seasonNumber: 1, name: 'Season 1', episodeCount: 9, status: 5 },
      { seasonNumber: 2, name: 'Season 2', episodeCount: 10 },
      { seasonNumber: 3, name: 'Season 3', episodeCount: 8 },
    ];

    it('requests a new season of a partially available show', async () => {
      const result = await pickSeasons(seasonSession(seasons), [2]);

      expect(result.state).toBe('AWAITING_CONFIRMATION');
      expect(result.message).toContain('Season 2');
      expect(vi.mocked(conversationSessionRepository.update).mock.calls[0][1]).toMatchObject({
        selectedSeasons: [2],
      });
    });

    it('"all" only requests seasons that are not yet available', async () => {
      const result = await pickSeasons(seasonSession(seasons), 'all');

      expect(result.message).toContain('Seasons 2, 3');
      expect(vi.mocked(conversationSessionRepository.update).mock.calls[0][1]).toMatchObject({
        selectedSeasons: [2, 3],
      });
    });

    it('"all" on a show with nothing requested still says "All N seasons"', async () => {
      const fresh = seasons.map(({ status: _status, ...s }) => s);

      const result = await pickSeasons(seasonSession(fresh), 'all');

      expect(result.message).toContain('All 3 seasons');
      expect(vi.mocked(conversationSessionRepository.update).mock.calls[0][1]).toMatchObject({
        selectedSeasons: [1, 2, 3],
      });
    });

    it('drops already-available seasons from a mixed pick and says so', async () => {
      const result = await pickSeasons(seasonSession(seasons), [1, 3]);

      expect(result.state).toBe('AWAITING_CONFIRMATION');
      expect(result.message).toContain(
        'Season 3 (skipping Season 1, already available or requested)'
      );
      expect(vi.mocked(conversationSessionRepository.update).mock.calls[0][1]).toMatchObject({
        selectedSeasons: [3],
      });
    });

    it('re-prompts when only already-available seasons are picked', async () => {
      const result = await pickSeasons(seasonSession(seasons), [1]);

      expect(result.state).toBe('AWAITING_SEASON_SELECTION');
      expect(result.message).toContain('Season 1 is already available or requested');
      expect(result.message).toContain('Seasons you can request: 2, 3');
      expect(conversationSessionRepository.update).not.toHaveBeenCalled();
    });

    it('still rejects season numbers the show does not have', async () => {
      const result = await pickSeasons(seasonSession(seasons), [7]);

      expect(result.state).toBe('AWAITING_SEASON_SELECTION');
      expect(result.message).toContain('Invalid season(s): 7');
    });
  });
});
