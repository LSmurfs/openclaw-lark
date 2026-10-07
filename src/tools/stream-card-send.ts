import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import type { OpenClawConfig, OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import {
  createCardEntity,
  sendCardByCardId,
  setCardStreamingMode,
  streamCardContent,
  updateCardKitCard,
} from '../card/cardkit';
import { normalizeFeishuTarget } from '../core/targets';
import { formatToolResult, getFirstAccount, getResolvedConfig, registerTool } from './helpers';

const ELEMENT_ID = 'streaming_content';
const DEFAULT_SUMMARY = 'AI\u70ed\u641c\u65b0\u95fb\u6c47\u603b';

export function buildLegacyStreamingCard(content: string, summary: string): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { streaming_mode: true, update_multi: true, summary: { content: summary } },
    body: {
      elements: [{ tag: 'markdown', element_id: ELEMENT_ID, content, text_align: 'left', text_size: 'normal_v2' }],
    },
  };
}

export function buildLegacyCompleteCard(content: string, elapsedMs: number, summary: string): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: summary } },
    body: {
      elements: [
        { tag: 'markdown', content },
        { tag: 'hr' },
        { tag: 'markdown', content: `\u5b8c\u6210 \u00b7 ${(elapsedMs / 1000).toFixed(1)}s`, text_size: 'notation' },
      ],
    },
  };
}

interface SendParams {
  cfg: OpenClawConfig;
  target: string;
  text: string;
  receiptDir: string;
  accountId?: string;
  summary?: string;
  doneSummary?: string;
}

interface Receipt {
  ok: boolean;
  completed: boolean;
  cardId?: string;
  messageId?: string;
  chatId?: string;
}

export async function sendLegacyStreamCard(params: SendParams): Promise<Receipt & { skipped: boolean }> {
  const { cfg, accountId, receiptDir } = params;
  const target = normalizeFeishuTarget(params.target);
  const text = params.text.trim();
  if (!target || !/^(ou_|oc_)[a-zA-Z0-9]+$/.test(target)) throw new Error('A valid, explicit Feishu target is required.');
  if (!text || text.length > 100_000) throw new Error('text must contain 1 to 100000 characters.');
  const summary = params.summary ?? DEFAULT_SUMMARY;
  const doneSummary = params.doneSummary ?? `${summary}\u5b8c\u6210`;
  const key = createHash('sha256').update(JSON.stringify([accountId, target, text, summary, doneSummary])).digest('hex');
  mkdirSync(receiptDir, { recursive: true });
  const file = join(receiptDir, `${key}.json`);
  const receipt: Receipt = { ok: false, completed: false };

  // Claim before sending; ambiguous/partial sends stay locked, including after a restart.
  try {
    writeFileSync(file, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const previous = JSON.parse(readFileSync(file, 'utf8')) as Receipt;
    if (previous.ok && previous.completed && previous.messageId) return { ...previous, skipped: true };
    throw new Error(`Previous send is pending or incomplete; do not resend. messageId=${previous.messageId ?? 'unknown'}`, { cause: error });
  }

  let sequence = 1;
  let sendAttempted = false;
  let streamingClosed = false;
  try {
    const chunks: string[] = [];
    for (let end = 600; end < text.length + 600; end += 600) chunks.push(text.slice(0, end));
    const cardId = await createCardEntity({ cfg, accountId, card: buildLegacyStreamingCard(chunks[0], summary) });
    if (!cardId) throw new Error('card.create returned no card_id');
    receipt.cardId = cardId;
    writeFileSync(file, JSON.stringify(receipt));
    sendAttempted = true;
    const sent = await sendCardByCardId({ cfg, accountId, to: target, cardId });
    if (!sent.messageId) throw new Error('Card send returned no message_id; delivery is uncertain.');
    Object.assign(receipt, sent);
    writeFileSync(file, JSON.stringify(receipt));
    for (const content of chunks) {
      await streamCardContent({ cfg, accountId, cardId, elementId: ELEMENT_ID, content, sequence: ++sequence });
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await setCardStreamingMode({ cfg, accountId, cardId, streamingMode: false, sequence: ++sequence });
    streamingClosed = true;
    await updateCardKitCard({
      cfg, accountId, cardId, sequence: ++sequence,
      card: buildLegacyCompleteCard(text, chunks.length * 350, doneSummary),
    });
    Object.assign(receipt, { ok: true, completed: true });
    writeFileSync(file, JSON.stringify(receipt));
    return { ...receipt, skipped: false };
  } catch (error) {
    if (!sendAttempted) unlinkSync(file);
    if (receipt.messageId && receipt.cardId && !streamingClosed) {
      await setCardStreamingMode({ cfg, accountId, cardId: receipt.cardId, streamingMode: false, sequence: sequence + 1 }).catch(() => undefined);
    }
    throw new Error(`${error instanceof Error ? error.message : String(error)}${sendAttempted ? `; do not resend, messageId=${receipt.messageId ?? 'unknown'}` : ''}`, { cause: error });
  }
}

export function registerStreamCardSendTool(api: OpenClawPluginApi): void {
  registerTool(api, {
    name: 'feishu_stream_card_send',
    label: 'Send Feishu Streaming Card',
    description:
      'Send Markdown through the legacy CardKit streaming card, then finalize the same card. ' +
      'Requires an explicit target. Identical content is sent only once, persistently. ' +
      'Never retry or send a text/JSON fallback after an uncertain or partial send.',
    parameters: Type.Object({
      target: Type.String({ minLength: 1, description: 'Explicit Feishu user:ou_... or chat:oc_... target.' }),
      text: Type.String({ minLength: 1, maxLength: 100_000, description: 'Complete Markdown news body, not card JSON.' }),
      summary: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      done_summary: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    }),
    async execute(_toolCallId: string, raw: unknown) {
      const params = raw as { target: string; text: string; summary?: string; done_summary?: string };
      const cfg = getResolvedConfig(api.config);
      const workspace = cfg.agents?.defaults?.workspace;
      if (!workspace) throw new Error('A configured workspace is required for persistent send receipts.');
      const account = getFirstAccount(cfg);
      return formatToolResult(await sendLegacyStreamCard({
        cfg, target: params.target, text: params.text,
        summary: params.summary, doneSummary: params.done_summary, accountId: account.accountId,
        receiptDir: join(workspace, '.openclaw', 'tmp', 'feishu-stream-card-tool'),
      }));
    },
  }, { optional: true });
}
