import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFindByKey, mockFindAllConnections, mockFindSession } = vi.hoisted(() => ({
  mockFindByKey: vi.fn(),
  mockFindAllConnections: vi.fn(),
  mockFindSession: vi.fn(),
}));

vi.mock('../../../repositories/setting.repository.js', () => ({
  settingRepository: { findByKey: mockFindByKey },
}));

vi.mock('../../../repositories/contact.repository.js', () => ({
  contactRepository: { findByPhoneHash: vi.fn() },
}));

vi.mock('../../../repositories/whatsapp-connection.repository.js', () => ({
  whatsappConnectionRepository: { findAll: mockFindAllConnections },
}));

vi.mock('../../../repositories/conversation-session.repository.js', () => ({
  conversationSessionRepository: { findByPhoneHash: mockFindSession },
}));

vi.mock('../whatsapp-client.service.js', () => ({
  whatsappClientService: {
    getClient: vi.fn(),
    isSentByBot: vi.fn(() => false),
    onMessage: vi.fn(),
  },
}));

vi.mock('../../../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { messageHandlerService } from '../message-handler.service.js';

function shouldProcess(message: string) {
  return (messageHandlerService as any).shouldProcessMessage(message, 'hash', false) as Promise<{
    shouldProcess: boolean;
    cleanedMessage: string;
    allowNewSearch: boolean;
  }>;
}

/**
 * While a menu is open, unprefixed messages are let through so the user can
 * answer "2" or "cancel" - but they must not be allowed to start a new search,
 * or ordinary chat keeps restarting searches and the menu never closes.
 */
describe('MessageHandlerService prefix filter with an open menu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindByKey.mockResolvedValue(null); // allow-list off
    mockFindAllConnections.mockResolvedValue([{ filterType: 'prefix', filterValue: '!wamr' }]);
    mockFindSession.mockResolvedValue({ state: 'AWAITING_SELECTION' });
  });

  it('lets an unprefixed reply through, but not as a new search', async () => {
    const result = await shouldProcess('2');

    expect(result).toEqual({ shouldProcess: true, cleanedMessage: '2', allowNewSearch: false });
  });

  it('marks unprefixed chat as reply-only so it cannot restart the search', async () => {
    const result = await shouldProcess('what time is dinner');

    expect(result.shouldProcess).toBe(true);
    expect(result.allowNewSearch).toBe(false);
  });

  it('lets a prefixed message start a new search and strips the prefix', async () => {
    const result = await shouldProcess('!wamr Arrival');

    expect(result).toEqual({
      shouldProcess: true,
      cleanedMessage: 'Arrival',
      allowNewSearch: true,
    });
  });

  it('strips the prefix from a prefixed reply', async () => {
    const result = await shouldProcess('!wamr 2');

    expect(result.cleanedMessage).toBe('2');
  });

  it('ignores unprefixed chat when no menu is open', async () => {
    mockFindSession.mockResolvedValue({ state: 'IDLE' });

    const result = await shouldProcess('what time is dinner');

    expect(result.shouldProcess).toBe(false);
  });

  it('applies the same rule to the keyword filter', async () => {
    mockFindAllConnections.mockResolvedValue([{ filterType: 'keyword', filterValue: 'wamr' }]);

    expect((await shouldProcess('hey wamr Arrival')).allowNewSearch).toBe(true);
    expect((await shouldProcess('lol')).allowNewSearch).toBe(false);
  });

  it('allows new searches from any message when no filter is configured', async () => {
    mockFindAllConnections.mockResolvedValue([]);

    const result = await shouldProcess('Arrival');

    expect(result).toEqual({
      shouldProcess: true,
      cleanedMessage: 'Arrival',
      allowNewSearch: true,
    });
  });
});
