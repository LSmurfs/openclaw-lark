import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpenClawConfig, OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(), send: vi.fn(), stream: vi.fn(), settings: vi.fn(), update: vi.fn(), register: vi.fn(),
}));
vi.mock('../src/card/cardkit', () => ({
  createCardEntity: mocks.create,
  sendCardByCardId: mocks.send,
  streamCardContent: mocks.stream,
  setCardStreamingMode: mocks.settings,
  updateCardKitCard: mocks.update,
}));
vi.mock('../src/tools/helpers', () => ({
  registerTool: mocks.register,
  getFirstAccount: () => ({ accountId: 'test' }),
  getResolvedConfig: (cfg: unknown) => cfg,
  formatToolResult: (details: unknown) => ({ details }),
}));

import { buildLegacyCompleteCard, buildLegacyStreamingCard, registerStreamCardSendTool, sendLegacyStreamCard } from '../src/tools/stream-card-send';

describe('legacy streaming-card messaging tool', () => {
  let dir: string;
  const cfg = {} as OpenClawConfig;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    dir = mkdtempSync(join(tmpdir(), 'stream-card-test-'));
    mocks.create.mockResolvedValue('card-1');
    mocks.send.mockResolvedValue({ messageId: 'message-1', chatId: 'chat-1' });
    mocks.stream.mockResolvedValue(undefined);
    mocks.settings.mockResolvedValue(undefined);
    mocks.update.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });
  const params = (receiptDir: string, text = 'news') => ({ cfg, target: 'user:ou_test', text, receiptDir });
  const finish = async <T>(promise: Promise<T>) => {
    await vi.runAllTimersAsync();
    return promise;
  };

  it('preserves the old initial and final CardKit JSON format', () => {
    expect(buildLegacyStreamingCard('body', 'title')).toEqual({
      schema: '2.0',
      config: { streaming_mode: true, update_multi: true, summary: { content: 'title' } },
      body: { elements: [{ tag: 'markdown', element_id: 'streaming_content', content: 'body', text_align: 'left', text_size: 'normal_v2' }] },
    });
    expect(buildLegacyCompleteCard('body', 700, 'done')).toEqual({
      schema: '2.0', config: { update_multi: true, summary: { content: 'done' } },
      body: { elements: [
        { tag: 'markdown', content: 'body' }, { tag: 'hr' },
        { tag: 'markdown', content: '\u5b8c\u6210 \u00b7 0.7s', text_size: 'notation' },
      ] },
    });
  });

  it('creates one card, streams cumulative chunks, closes and finalizes that same card', async () => {
    const text = 'x'.repeat(1201);
    const result = await finish(sendLegacyStreamCard(params(dir, text)));
    expect(result).toMatchObject({ ok: true, completed: true, messageId: 'message-1', skipped: false });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith({ cfg, accountId: undefined, to: 'ou_test', cardId: 'card-1' });
    expect(mocks.stream.mock.calls.map(([p]) => [p.content.length, p.sequence])).toEqual([[600, 2], [1200, 3], [1201, 4]]);
    expect(mocks.settings).toHaveBeenCalledWith(expect.objectContaining({ streamingMode: false, sequence: 5 }));
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ cardId: 'card-1', sequence: 6 }));
    expect(mocks.update.mock.calls[0][0].card.body.elements[0].content).toBe(text);
  });

  it('suppresses completed duplicates persistently, including target aliases', async () => {
    await finish(sendLegacyStreamCard(params(dir)));
    const duplicate = await sendLegacyStreamCard({ ...params(dir), target: 'ou_test' });
    expect(duplicate).toMatchObject({ ok: true, skipped: true, messageId: 'message-1' });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it('claims the receipt before allowing a concurrent identical send', async () => {
    const first = sendLegacyStreamCard(params(dir));
    await expect(sendLegacyStreamCard(params(dir))).rejects.toThrow('do not resend');
    await finish(first);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it('allows different content and different accounts', async () => {
    await finish(sendLegacyStreamCard(params(dir)));
    await finish(sendLegacyStreamCard(params(dir, 'other news')));
    await finish(sendLegacyStreamCard({ ...params(dir), accountId: 'another' }));
    expect(mocks.send).toHaveBeenCalledTimes(3);
  });

  it('rejects empty content, oversized content and invalid targets before any API call', async () => {
    for (const p of [{ ...params(dir), text: ' ' }, { ...params(dir), text: 'x'.repeat(100001) }, { ...params(dir), target: 'last' }]) {
      await expect(sendLegacyStreamCard(p)).rejects.toThrow();
    }
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('clears the claim when creation fails before any send attempt', async () => {
    mocks.create.mockRejectedValueOnce(new Error('create failed'));
    await expect(sendLegacyStreamCard(params(dir))).rejects.toThrow('create failed');
    expect(readdirSync(dir)).toEqual([]);
    await finish(sendLegacyStreamCard(params(dir)));
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing card id without sending', async () => {
    mocks.create.mockResolvedValueOnce(null);
    await expect(sendLegacyStreamCard(params(dir))).rejects.toThrow('no card_id');
    expect(mocks.send).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('does not resend after a send timeout with uncertain delivery', async () => {
    mocks.send.mockRejectedValueOnce(new Error('timeout'));
    await expect(sendLegacyStreamCard(params(dir))).rejects.toThrow('do not resend');
    await expect(sendLegacyStreamCard(params(dir))).rejects.toThrow('do not resend');
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it('preserves partial-delivery receipts and closes streaming on an update failure', async () => {
    mocks.stream.mockRejectedValueOnce(new Error('stream failed'));
    await expect(sendLegacyStreamCard(params(dir))).rejects.toThrow('messageId=message-1');
    expect(mocks.settings).toHaveBeenCalledWith(expect.objectContaining({ streamingMode: false }));
    expect(JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8'))).toMatchObject({ completed: false, messageId: 'message-1' });
    await expect(sendLegacyStreamCard(params(dir))).rejects.toThrow('messageId=message-1');
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it('fails closed on a corrupt receipt rather than sending twice', async () => {
    await finish(sendLegacyStreamCard(params(dir)));
    writeFileSync(join(dir, readdirSync(dir)[0]), '{corrupt');
    await expect(sendLegacyStreamCard(params(dir))).rejects.toThrow();
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it('registers an optional messaging tool with explicit Markdown and target parameters', () => {
    registerStreamCardSendTool({ config: cfg } as OpenClawPluginApi);
    const [, tool, options] = mocks.register.mock.calls[0];
    expect(tool.name).toBe('feishu_stream_card_send');
    expect(tool.parameters.required).toEqual(['target', 'text']);
    expect(options).toEqual({ optional: true });
  });
});
