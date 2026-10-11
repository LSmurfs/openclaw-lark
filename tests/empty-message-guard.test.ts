/**
 * Tests for empty-message rejection and command authorization in handleFeishuMessage.
 *
 * Verifies that messages with no text content and no media resources
 * are skipped before reaching the enrichment/gate/dispatch pipeline.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shouldComputeCommandAuthorized } from 'openclaw/plugin-sdk/command-detection';
import type { FeishuConfig, FeishuGroupConfig } from '../src/core/types';

// ---------------------------------------------------------------------------
// Module mocks (hoisted)
// ---------------------------------------------------------------------------

const mockParseMessageEvent = vi.fn();
const mockResolveSenderInfo = vi.fn();
const mockPrefetchUserNames = vi.fn();
const mockResolveMedia = vi.fn();
const mockResolveQuotedContent = vi.fn();
const mockSubstituteMediaPaths = vi.fn();

vi.mock('../src/messaging/inbound/parse', () => ({
  parseMessageEvent: (...args: unknown[]) => mockParseMessageEvent(...args),
}));

vi.mock('../src/messaging/inbound/enrich', () => ({
  resolveSenderInfo: (...args: unknown[]) => mockResolveSenderInfo(...args),
  prefetchUserNames: (...args: unknown[]) => mockPrefetchUserNames(...args),
  resolveMedia: (...args: unknown[]) => mockResolveMedia(...args),
  resolveQuotedContent: (...args: unknown[]) => mockResolveQuotedContent(...args),
  substituteMediaPaths: (...args: unknown[]) => mockSubstituteMediaPaths(...args),
}));

vi.mock('../src/messaging/inbound/gate', () => ({
  checkMessageGate: vi.fn().mockResolvedValue({ allowed: true }),
  readFeishuAllowFromStore: vi.fn().mockResolvedValue([]),
}));

vi.mock('../src/messaging/inbound/handler-registry', () => ({
  injectInboundHandler: vi.fn(),
}));

vi.mock('../src/messaging/inbound/dispatch', () => ({
  dispatchToAgent: vi.fn(),
}));

vi.mock('../src/messaging/inbound/policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/messaging/inbound/policy')>();
  return {
    resolveFeishuGroupConfig: vi.fn(),
    splitLegacyGroupAllowFrom: actual.splitLegacyGroupAllowFrom,
  };
});

vi.mock('../src/core/accounts', () => ({
  getLarkAccount: vi.fn().mockReturnValue({
    accountId: 'test-account',
    config: {},
    enabled: true,
    configured: true,
  }),
}));

vi.mock('../src/core/lark-client', async () => ({
  LarkClient: {
    runtime: {
      channel: {
        commands: {
          shouldComputeCommandAuthorized: vi.fn().mockReturnValue(false),
          resolveCommandAuthorizedFromAuthorizers: (await import('openclaw/plugin-sdk/command-auth-native')).resolveCommandAuthorizedFromAuthorizers,
        },
      },
    },
  },
}));

vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../src/core/lark-ticket', () => ({
  ticketElapsed: () => 1,
}));

vi.mock('../src/channel/chat-queue', () => ({
  threadScopedKey: (chatId: string, threadId?: string) => `${chatId}:${threadId ?? ''}`,
}));

vi.mock('openclaw/plugin-sdk/reply-history', () => ({
  DEFAULT_GROUP_HISTORY_LIMIT: 20,
  recordPendingHistoryEntryIfEnabled: vi.fn(),
}));

// Import after mocks
import { handleFeishuMessage } from '../src/messaging/inbound/handler';
import { dispatchToAgent } from '../src/messaging/inbound/dispatch';
import { readFeishuAllowFromStore } from '../src/messaging/inbound/gate';
import { resolveFeishuGroupConfig } from '../src/messaging/inbound/policy';
import { getLarkAccount } from '../src/core/accounts';
import { LarkClient } from '../src/core/lark-client';

const mockDispatchToAgent = vi.mocked(dispatchToAgent);

describe('handleFeishuMessage command authorization with the public SDK', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(LarkClient.runtime.channel.commands.shouldComputeCommandAuthorized)
      .mockImplementation(shouldComputeCommandAuthorized);
    vi.mocked(readFeishuAllowFromStore).mockResolvedValue([]);
    vi.mocked(resolveFeishuGroupConfig).mockReturnValue(undefined);
    mockResolveMedia.mockResolvedValue({ mediaList: [], payload: undefined });
    mockResolveQuotedContent.mockResolvedValue(undefined);
  });

  it.each<{
    name: string;
    config: Partial<FeishuConfig>;
    isGroup?: boolean;
    store?: string[];
    groupConfig?: FeishuGroupConfig;
    expected?: boolean;
    readsStore?: boolean;
    storeError?: boolean;
    content?: string;
  }>([
    { name: 'configured DM owner', config: { allowFrom: ['ou_sender'] }, expected: true, readsStore: true },
    { name: 'unknown DM sender', config: {}, expected: false, readsStore: true },
    { name: 'paired DM sender', config: {}, store: ['ou_sender'], expected: true, readsStore: true },
    { name: 'unreadable pairing store fails closed', config: {}, storeError: true, expected: false, readsStore: true },
    { name: 'configured owner survives a store error', config: { allowFrom: ['ou_sender'] }, storeError: true, expected: true, readsStore: true },
    { name: 'allowlist DM ignores pairing store', config: { dmPolicy: 'allowlist' }, store: ['ou_sender'], expected: false },
    { name: 'allowlist DM owner', config: { dmPolicy: 'allowlist', allowFrom: ['ou_sender'] }, expected: true },
    { name: 'open DM does not grant command access', config: { dmPolicy: 'open' }, store: ['ou_sender'], expected: false },
    { name: 'explicit wildcard DM command access', config: { dmPolicy: 'open', allowFrom: ['*'] }, expected: true },
    { name: 'group owner', config: { allowFrom: ['ou_sender'] }, isGroup: true, expected: true },
    { name: 'group sender allowlist', config: { groupAllowFrom: ['ou_sender'] }, isGroup: true, expected: true },
    { name: 'per-group sender allowlist', config: {}, groupConfig: { allowFrom: ['ou_sender'] }, isGroup: true, expected: true },
    { name: 'group ignores paired DM senders', config: {}, store: ['ou_sender'], isGroup: true, expected: false },
    { name: 'legacy chat ID is not a sender grant', config: { groupAllowFrom: ['oc_chat'] }, isGroup: true, expected: false },
    { name: 'explicitly open group', config: { groupPolicy: 'open' }, isGroup: true, expected: true },
    { name: 'open group with a sender allowlist stays restricted', config: { groupPolicy: 'open', groupAllowFrom: ['ou_other'] }, isGroup: true, expected: false },
    { name: 'ordinary text has no command decision', config: { allowFrom: ['ou_sender'] }, content: 'hello', readsStore: true },
  ])('$name', async ({ config: overrides, isGroup, store, groupConfig, expected, readsStore, storeError, content = '/status' }) => {
    const config: FeishuConfig = { allowFrom: undefined, groupAllowFrom: undefined, ...overrides };
    vi.mocked(getLarkAccount).mockReturnValue({
      accountId: 'test-account', config, enabled: true, configured: false, brand: 'feishu',
    });
    vi.mocked(resolveFeishuGroupConfig).mockReturnValue(groupConfig);
    if (storeError) vi.mocked(readFeishuAllowFromStore).mockRejectedValueOnce(new Error('store unavailable'));
    else vi.mocked(readFeishuAllowFromStore).mockResolvedValue(store ?? []);
    const ctx = { ...makeCtx(content), chatType: isGroup ? 'group' as const : 'p2p' as const };
    mockParseMessageEvent.mockResolvedValue(ctx);
    mockResolveSenderInfo.mockResolvedValue({ ctx, permissionError: undefined });

    await handleFeishuMessage({
      cfg: { channels: { feishu: { allowFrom: ['ou_other'] } } },
      event: makeEvent(content),
    });

    expect(mockDispatchToAgent).toHaveBeenCalledWith(expect.objectContaining({ commandAuthorized: expected }));
    expect(LarkClient.runtime.channel.commands.shouldComputeCommandAuthorized)
      .toHaveBeenCalledWith(content, expect.objectContaining({ channels: { feishu: config } }));
    if (readsStore) expect(readFeishuAllowFromStore).toHaveBeenCalledExactlyOnceWith('test-account');
    else expect(readFeishuAllowFromStore).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(content: string) {
  return {
    sender: { sender_id: { open_id: 'ou_sender' } },
    message: {
      message_id: 'om_test',
      chat_id: 'oc_chat',
      chat_type: 'p2p' as const,
      message_type: 'text',
      content,
    },
  };
}

function makeCtx(content: string, resources: unknown[] = []) {
  return {
    chatId: 'oc_chat',
    messageId: 'om_test',
    senderId: 'ou_sender',
    chatType: 'p2p' as const,
    content,
    contentType: 'text',
    resources,
    mentions: [],
    mentionAll: false,
    rawMessage: {},
    rawSender: {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleFeishuMessage — empty message guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSenderInfo.mockResolvedValue({
      ctx: makeCtx('hello'),
      permissionError: undefined,
    });
  });

  it('skips messages with empty content and no resources', async () => {
    mockParseMessageEvent.mockResolvedValue(makeCtx('', []));

    await handleFeishuMessage({
      cfg: { channels: { feishu: {} } } as never,
      event: makeEvent(''),
    });

    // Should NOT reach enrichment or dispatch
    expect(mockResolveSenderInfo).not.toHaveBeenCalled();
    expect(mockDispatchToAgent).not.toHaveBeenCalled();
  });

  it('skips messages with whitespace-only content and no resources', async () => {
    mockParseMessageEvent.mockResolvedValue(makeCtx('   ', []));

    await handleFeishuMessage({
      cfg: { channels: { feishu: {} } } as never,
      event: makeEvent('   '),
    });

    expect(mockResolveSenderInfo).not.toHaveBeenCalled();
    expect(mockDispatchToAgent).not.toHaveBeenCalled();
  });

  it('skips messages with empty string content and no resources', async () => {
    // The content converter resolves {"text":""} to "" during parse,
    // so by the time the guard runs ctx.content is already "".
    mockParseMessageEvent.mockResolvedValue(makeCtx('', []));

    await handleFeishuMessage({
      cfg: { channels: { feishu: {} } } as never,
      event: makeEvent(''),
    });

    expect(mockResolveSenderInfo).not.toHaveBeenCalled();
    expect(mockDispatchToAgent).not.toHaveBeenCalled();
  });

  it('allows messages with text content even without resources', async () => {
    mockParseMessageEvent.mockResolvedValue(makeCtx('hello world', []));
    mockResolveMedia.mockResolvedValue({ mediaList: [], payload: undefined });
    mockResolveQuotedContent.mockResolvedValue(undefined);

    await handleFeishuMessage({
      cfg: { channels: { feishu: {} } } as never,
      event: makeEvent('hello world'),
    });

    expect(mockResolveSenderInfo).toHaveBeenCalled();
  });

  it('allows messages with resources even when content is empty', async () => {
    const resources = [{ type: 'image' as const, fileKey: 'img_key' }];
    mockParseMessageEvent.mockResolvedValue(makeCtx('', resources));
    mockResolveMedia.mockResolvedValue({ mediaList: [], payload: undefined });
    mockResolveQuotedContent.mockResolvedValue(undefined);

    await handleFeishuMessage({
      cfg: { channels: { feishu: {} } } as never,
      event: makeEvent(''),
    });

    expect(mockResolveSenderInfo).toHaveBeenCalled();
  });

  it('allows a bare @-mention (no text, no media) as a valid ping', async () => {
    const ctx = {
      ...makeCtx('', []),
      mentions: [{ openId: 'ou_bot', name: 'Bot', isBot: true }],
    };
    mockParseMessageEvent.mockResolvedValue(ctx);
    mockResolveSenderInfo.mockResolvedValue({ ctx, permissionError: undefined });
    mockResolveMedia.mockResolvedValue({ mediaList: [], payload: undefined });
    mockResolveQuotedContent.mockResolvedValue(undefined);

    await handleFeishuMessage({
      cfg: { channels: { feishu: {} } } as never,
      event: makeEvent(''),
    });

    // A pure @ must NOT be dropped as an empty message.
    expect(mockResolveSenderInfo).toHaveBeenCalled();
  });

  it('allows an @all with no text as a valid ping', async () => {
    const ctx = { ...makeCtx('', []), mentionAll: true };
    mockParseMessageEvent.mockResolvedValue(ctx);
    mockResolveSenderInfo.mockResolvedValue({ ctx, permissionError: undefined });
    mockResolveMedia.mockResolvedValue({ mediaList: [], payload: undefined });
    mockResolveQuotedContent.mockResolvedValue(undefined);

    await handleFeishuMessage({
      cfg: { channels: { feishu: {} } } as never,
      event: makeEvent(''),
    });

    expect(mockResolveSenderInfo).toHaveBeenCalled();
  });
});
