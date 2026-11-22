import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DisconnectReason } from '@whiskeysockets/baileys';
import { WhatsAppClientService } from '../whatsapp-client.service.js';

// vi.hoisted runs before vi.mock factories, so the mock factories can reference it.
const { existingConnection } = vi.hoisted(() => ({
  existingConnection: {
    id: 1,
    phoneNumberHash: '',
    status: 'DISCONNECTED' as const,
    lastConnectedAt: null,
    qrCodeGeneratedAt: null,
    filterType: null,
    filterValue: null,
    processFromSelf: false,
    processGroups: false,
    markOnlineOnConnect: false,
    autoApprovalMode: 'auto_approve' as const,
    exceptionsEnabled: false,
    exceptionContacts: [] as string[],
    createdAt: new Date(),
    updatedAt: new Date(),
  },
}));

// Mock the modules that the reconnect logic touches so we can observe behavior
// without actually spinning up a Baileys socket or a database.
vi.mock('../qr-code-emitter.service.js', () => ({
  qrCodeEmitterService: {
    emitConnectionStatus: vi.fn(),
    emitQRCode: vi.fn(),
  },
}));

vi.mock('../../repositories/whatsapp-connection.repository.js', () => ({
  whatsappConnectionRepository: {
    getFirst: vi.fn().mockResolvedValue(existingConnection),
    getActive: vi.fn().mockResolvedValue(existingConnection),
    // Returning a non-empty array is critical: updateConnectionStatus() short-circuits
    // when no connection record exists, which would mean `update` is never called and
    // the RECONNECTING status never lands in the DB.
    findAll: vi.fn().mockResolvedValue([existingConnection]),
    upsert: vi.fn().mockImplementation(async (data: { status: string }) => ({
      ...existingConnection,
      status: data.status,
    })),
    update: vi.fn().mockImplementation(async (_id: number, data: { status: string }) => ({
      ...existingConnection,
      status: data.status,
    })),
  },
}));

vi.mock('../../repositories/contact.repository.js', () => ({
  contactRepository: {
    findLidOnly: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../conversation/conversation.service.js', () => ({
  conversationService: {
    mergeLidContact: vi.fn(),
  },
}));

vi.mock('../encryption/hashing.service.js', () => ({
  hashingService: {
    hashPhoneNumber: vi.fn().mockResolvedValue('hash'),
  },
}));

/**
 * Reconnect behavior — the service should:
 *  - Never reconnect on a `loggedOut` close.
 *  - On any other close after a real session, schedule an auto-reconnect.
 *  - Cap retries at MAX_RECONNECT_ATTEMPTS, leaving the status as DISCONNECTED
 *    when the cap is hit.
 *  - Cancel any pending retry on cancelReconnect().
 *
 * We assert on the service's internal state (reconnectAttempts, reconnectTimer)
 * rather than on side-effect mocks because the service uses both static imports
 * (DB repo) and dynamic imports (QR emitter), and observing cross-import spy
 * calls is fragile. The actual production behavior is the same: side effects fire
 * inside scheduleReconnect() before the timer is armed.
 */
describe('WhatsAppClientService auto-reconnect', () => {
  let service: WhatsAppClientService;

  beforeEach(() => {
    service = new WhatsAppClientService();
  });

  afterEach(() => {
    // Stop any timers the tests may have armed so they don't leak across tests.
    // @ts-expect-error — private method
    service.cancelReconnect();
  });

  async function callScheduleReconnect(args: {
    statusCode: number | undefined;
    hadEstablishedSession: boolean;
    isRestartRequired: boolean;
  }) {
    // @ts-expect-error — invoking private for testing
    await service.scheduleReconnect(
      args.statusCode,
      args.hadEstablishedSession,
      args.isRestartRequired
    );
  }

  it('does NOT schedule a reconnect when status is loggedOut', async () => {
    await callScheduleReconnect({
      statusCode: DisconnectReason.loggedOut,
      hadEstablishedSession: true,
      isRestartRequired: false,
    });

    // @ts-expect-error — private field
    expect(service.reconnectAttempts).toBe(0);
    // @ts-expect-error — private field
    expect(service.reconnectTimer).toBeNull();
  });

  it('schedules a reconnect on transient close (e.g. 428) after a real session', async () => {
    await callScheduleReconnect({
      statusCode: 428, // connectionClosed
      hadEstablishedSession: true,
      isRestartRequired: false,
    });

    // @ts-expect-error — private field
    expect(service.reconnectAttempts).toBe(1);
    // @ts-expect-error — private field
    expect(service.reconnectTimer).not.toBeNull();
  });

  it('uses 515 restart signal as a reconnect trigger even without a prior session', async () => {
    await callScheduleReconnect({
      statusCode: 515, // restartRequired
      hadEstablishedSession: false,
      isRestartRequired: true,
    });

    // @ts-expect-error — private field
    expect(service.reconnectAttempts).toBe(1);
    // @ts-expect-error — private field
    expect(service.reconnectTimer).not.toBeNull();
  });

  it('caps at MAX_RECONNECT_ATTEMPTS and stops scheduling more', async () => {
    for (let i = 0; i < 5; i++) {
      await callScheduleReconnect({
        statusCode: 428,
        hadEstablishedSession: true,
        isRestartRequired: false,
      });
    }

    // 5 attempts should have been scheduled; the 6th call should not start a new timer.
    // @ts-expect-error — private field
    expect(service.reconnectAttempts).toBe(5);
    // @ts-expect-error — private field
    expect(service.reconnectTimer).not.toBeNull();

    await callScheduleReconnect({
      statusCode: 428,
      hadEstablishedSession: true,
      isRestartRequired: false,
    });

    // 6th call hits the cap → counter resets, no new timer armed.
    // @ts-expect-error — private field
    expect(service.reconnectAttempts).toBe(0);
    // @ts-expect-error — private field
    expect(service.reconnectTimer).toBeNull();
  });

  it('cancelReconnect() clears the pending timer', async () => {
    await callScheduleReconnect({
      statusCode: 428,
      hadEstablishedSession: true,
      isRestartRequired: false,
    });
    // @ts-expect-error — private field
    expect(service.reconnectTimer).not.toBeNull();

    // @ts-expect-error — private method
    service.cancelReconnect();
    // @ts-expect-error — private field
    expect(service.reconnectTimer).toBeNull();
  });

  it('QR scan timeout (408, no prior session) schedules a QR loop restart', async () => {
    await callScheduleReconnect({
      statusCode: 408,
      hadEstablishedSession: false,
      isRestartRequired: false,
    });

    // The close handler routes QR-scan timeouts through scheduleReconnect too, so
    // the pairing window restarts automatically instead of dead-ending on
    // DISCONNECTED when the user simply didn't scan in time.
    // @ts-expect-error — private field
    expect(service.reconnectTimer).not.toBeNull();
    // @ts-expect-error — private field
    expect(service.reconnectAttempts).toBe(1);
  });
});

/**
 * Session clearing: the session dir is usually a bind mount whose parent the app
 * can't write to, so we must empty it rather than remove it. Regression test for
 * a 401 loop where fs.rm(dir) failed with EACCES and left revoked creds behind.
 */
describe('WhatsAppClientService clearSessionFiles', () => {
  let tmpRoot: string;
  let originalSessionPath: string;

  beforeEach(async () => {
    const os = await import('os');
    const fs = await import('fs/promises');
    const { env } = await import('../../../config/environment.js');
    tmpRoot = await fs.mkdtemp(`${os.tmpdir()}/wamr-session-`);
    originalSessionPath = env.WHATSAPP_SESSION_PATH;
    (env as { WHATSAPP_SESSION_PATH: string }).WHATSAPP_SESSION_PATH = `${tmpRoot}/auth`;
  });

  afterEach(async () => {
    const fs = await import('fs/promises');
    const { env } = await import('../../../config/environment.js');
    (env as { WHATSAPP_SESSION_PATH: string }).WHATSAPP_SESSION_PATH = originalSessionPath;
    await fs.chmod(tmpRoot, 0o755);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const clear = (service: WhatsAppClientService) =>
    (service as unknown as { clearSessionFiles: () => Promise<void> }).clearSessionFiles();

  it('empties the directory even when its parent is not writable', async () => {
    const fs = await import('fs/promises');
    const authDir = `${tmpRoot}/auth`;
    await fs.mkdir(`${authDir}/nested`, { recursive: true });
    await fs.writeFile(`${authDir}/creds.json`, '{}');
    await fs.writeFile(`${authDir}/nested/key.json`, '{}');
    // Parent read-only, like root-owned /app above a bind-mounted /app/.baileys_auth.
    await fs.chmod(tmpRoot, 0o555);

    await clear(new WhatsAppClientService());

    expect(await fs.readdir(authDir)).toEqual([]);
  });

  it('treats a missing directory as already cleared', async () => {
    await expect(clear(new WhatsAppClientService())).resolves.toBeUndefined();
  });
});
