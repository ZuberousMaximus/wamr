import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { Request, Response } from 'express';
import { setupRateLimiter } from '../../../src/api/middleware/rate-limit.middleware';
import { rateLimiterService } from '../../../src/services/auth/rate-limiter.service';
import setupRoutes from '../../../src/api/routes/setup.routes';

vi.mock('../../../src/services/auth/rate-limiter.service', () => ({
  rateLimiterService: {
    isAllowed: vi.fn(),
    getRemaining: vi.fn().mockReturnValue(4),
    getResetTime: vi.fn().mockReturnValue(Date.now() + 60_000),
  },
}));
vi.mock('../../../src/api/controllers/setup.controller.js', () => ({
  setupController: {
    getStatus: vi.fn(),
    completeSetup: vi.fn(),
    getBackupCodesCount: vi.fn(),
    regenerateBackupCodes: vi.fn(),
    resetPasswordWithBackupCode: vi.fn(),
  },
}));

describe('setupRateLimiter', () => {
  let res: Partial<Response>;
  const next = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    res = {
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
  });

  it('counts setup attempts separately from the general API limiter', () => {
    (rateLimiterService.isAllowed as Mock).mockReturnValue(true);

    setupRateLimiter({ ip: '192.168.2.20' } as Request, res as Response, next);

    expect((rateLimiterService.isAllowed as Mock).mock.calls[0][0]).toBe('setup:192.168.2.20');
    expect(next).toHaveBeenCalled();
  });

  it('rejects with 429 once the budget is spent', () => {
    (rateLimiterService.isAllowed as Mock).mockReturnValue(false);

    setupRateLimiter({ ip: '192.168.2.20' } as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('setup routes', () => {
  const handlersFor = (method: string, path: string) => {
    const layer = (setupRoutes as any).stack.find(
      (l: any) => l.route?.path === path && l.route.methods[method]
    );
    return layer.route.stack.map((s: any) => s.handle);
  };

  it.each(['/', '/backup-codes/regenerate', '/reset-password'])(
    'rate-limits POST %s, which checks a password or backup code',
    (path) => {
      expect(handlersFor('post', path)[0]).toBe(setupRateLimiter);
    }
  );

  it.each(['/status', '/backup-codes/count'])('leaves read-only GET %s unlimited', (path) => {
    expect(handlersFor('get', path)).not.toContain(setupRateLimiter);
  });
});
