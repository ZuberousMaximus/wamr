import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFindByKey, mockFindByPhoneHash, mockFindAllConnections, mockFindSession } = vi.hoisted(
  () => ({
    mockFindByKey: vi.fn(),
    mockFindByPhoneHash: vi.fn(),
    mockFindAllConnections: vi.fn(),
    mockFindSession: vi.fn(),
  })
);

vi.mock('../../../repositories/setting.repository.js', () => ({
  settingRepository: { findByKey: mockFindByKey },
}));

vi.mock('../../../repositories/contact.repository.js', () => ({
  contactRepository: { findByPhoneHash: mockFindByPhoneHash },
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

const HASH = 'abcdef0123456789';

/** Call the private gate the way the existing handler tests do */
function shouldProcess(message: string, hash = HASH, isFromMe = false) {
  return (messageHandlerService as any).shouldProcessMessage(message, hash, isFromMe) as Promise<{
    shouldProcess: boolean;
    cleanedMessage: string;
  }>;
}

describe('MessageHandlerService contact allow-list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No message filter and no active session unless a test says otherwise
    mockFindAllConnections.mockResolvedValue([]);
    mockFindSession.mockResolvedValue(null);
  });

  describe('when disabled (default)', () => {
    beforeEach(() => {
      mockFindByKey.mockResolvedValue(null);
    });

    it('answers a sender who is not in Contacts', async () => {
      const result = await shouldProcess('add Dune');

      expect(result.shouldProcess).toBe(true);
      expect(mockFindByPhoneHash).not.toHaveBeenCalled();
    });
  });

  describe('when enabled', () => {
    beforeEach(() => {
      mockFindByKey.mockResolvedValue({ key: 'contactAllowlistEnabled', value: true });
    });

    it('answers a sender who is in Contacts', async () => {
      mockFindByPhoneHash.mockResolvedValue({ id: 1, phoneNumberHash: HASH });

      const result = await shouldProcess('add Dune');

      expect(result.shouldProcess).toBe(true);
      expect(mockFindByPhoneHash).toHaveBeenCalledWith(HASH);
    });

    it('ignores a sender who is not in Contacts', async () => {
      mockFindByPhoneHash.mockResolvedValue(null);

      const result = await shouldProcess('add Dune');

      expect(result.shouldProcess).toBe(false);
    });

    it('ignores an unknown sender even mid-conversation', async () => {
      // A session in an interactive state normally bypasses the message filter;
      // the allow-list must still win so access can be revoked immediately.
      mockFindSession.mockResolvedValue({ state: 'AWAITING_SELECTION' });
      mockFindByPhoneHash.mockResolvedValue(null);

      const result = await shouldProcess('1');

      expect(result.shouldProcess).toBe(false);
    });

    it('still answers the linked account itself', async () => {
      mockFindByPhoneHash.mockResolvedValue(null);

      const result = await shouldProcess('add Dune', HASH, true);

      expect(result.shouldProcess).toBe(true);
      expect(mockFindByPhoneHash).not.toHaveBeenCalled();
    });

    it('fails closed when the contact lookup throws', async () => {
      mockFindByPhoneHash.mockRejectedValue(new Error('database is locked'));

      const result = await shouldProcess('add Dune');

      expect(result.shouldProcess).toBe(false);
    });

    it('still applies the prefix filter to an allowed sender', async () => {
      mockFindByPhoneHash.mockResolvedValue({ id: 1, phoneNumberHash: HASH });
      mockFindAllConnections.mockResolvedValue([{ filterType: 'prefix', filterValue: '!wamr' }]);

      const allowed = await shouldProcess('!wamr add Dune');
      expect(allowed.shouldProcess).toBe(true);
      expect(allowed.cleanedMessage).toBe('add Dune');

      const filtered = await shouldProcess('what time is dinner');
      expect(filtered.shouldProcess).toBe(false);
    });
  });

  describe('when the setting cannot be read', () => {
    it('preserves default behaviour rather than silencing the bot', async () => {
      mockFindByKey.mockRejectedValue(new Error('database is locked'));

      const result = await shouldProcess('add Dune');

      expect(result.shouldProcess).toBe(true);
      expect(mockFindByPhoneHash).not.toHaveBeenCalled();
    });
  });
});
