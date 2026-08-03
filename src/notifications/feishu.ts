import { createHmac } from 'node:crypto';

import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { Opportunity } from '../types.js';
import { sleep } from '../utils.js';

interface FeishuWebhookResponse {
  code?: number;
  msg?: string;
  StatusCode?: number;
  StatusMessage?: string;
}

type FeishuPayload = Record<string, unknown>;

interface FeishuQueueState {
  tail: Promise<void>;
  pending: number;
  sentAt: number[];
}

class FeishuWebhookError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs: number,
  ) {
    super(message);
  }
}

const queueByUrl = new Map<string, FeishuQueueState>();
const MAX_PENDING_MESSAGES = 100;
const MIN_REQUEST_INTERVAL_MS = 220;
const MAX_REQUESTS_PER_MINUTE = 100;

function number(value: number, maximumFractionDigits = 4): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  }).format(value);
}

function field(label: string, value: string): Record<string, unknown> {
  return {
    is_short: true,
    text: { tag: 'lark_md', content: `**${label}**\n${value}` },
  };
}

export function createFeishuSignature(timestamp: string | number, secret: string): string {
  const stringToSign = `${timestamp}\n${secret}`;
  return createHmac('sha256', stringToSign).update('').digest('base64');
}

function withSignature(payload: FeishuPayload, timestamp: number, secret?: string): FeishuPayload {
  if (!secret) return payload;
  const timestampText = String(timestamp);
  return {
    timestamp: timestampText,
    sign: createFeishuSignature(timestampText, secret),
    ...payload,
  };
}

export function buildFeishuOpportunityPayload(
  opportunity: Opportunity,
  options: { title: string; secret?: string; atAll: boolean; timestamp?: number },
): FeishuPayload {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1_000);
  const direction =
    opportunity.direction === 'CEX_BUY_DEX_SELL'
      ? 'Binance 买入 → Pancake 卖出'
      : 'Pancake 买入 → Binance 卖出';
  const status = opportunity.actionable ? '可执行候选' : '观察信号';
  const transfer =
    opportunity.transferReady === null
      ? '未核验'
      : opportunity.transferReady
        ? '已开启'
        : '已关闭';
  const details: Array<Record<string, unknown>> = [
    {
      tag: 'div',
      fields: [
        field('资产', `${opportunity.underlyingTicker} / ${opportunity.assetCode}`),
        field('方向', direction),
        field('预计净利润', `${opportunity.netProfitUsd >= 0 ? '+' : ''}${number(opportunity.netProfitUsd)} USDT`),
        field('预计净收益率', `${opportunity.netBps >= 0 ? '+' : ''}${number(opportunity.netBps, 2)} bps`),
        field('名义金额', `${number(opportunity.notionalUsd, 2)} USDT`),
        field('bStock 数量', number(opportunity.baseAmount, 8)),
        field('Binance 成交均价', number(opportunity.cexEffectivePrice, 8)),
        field('Pancake 成交均价', number(opportunity.dexEffectivePrice, 8)),
        field('Pancake 费率', `${number(opportunity.poolFee / 10_000, 4)}%`),
        field('报价耗时', `${opportunity.quoteLatencyMs} ms`),
        field('结算模式', opportunity.settlementMode),
        field('充值/提现通道', transfer),
      ],
    },
    { tag: 'hr' },
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**交易对** ${opportunity.cexSymbol}\n**Pancake Pool** ${opportunity.poolAddress}`,
      },
    },
  ];

  if (opportunity.reason) {
    details.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `**提示** ${opportunity.reason}` },
    });
  }
  if (options.atAll) {
    details.push({ tag: 'div', text: { tag: 'lark_md', content: '<at id=all></at>' } });
  }
  details.push(
    {
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '查看 Binance' },
          type: 'primary',
          url: `https://www.binance.com/en/trade/${encodeURIComponent(opportunity.assetCode)}_USDT?type=spot`,
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '查看链上池' },
          url: `https://bscscan.com/address/${encodeURIComponent(opportunity.poolAddress)}`,
        },
      ],
    },
    {
      tag: 'note',
      elements: [
        {
          tag: 'plain_text',
          content: `${status} · ${new Date(opportunity.detectedAt).toISOString()} · 只读监控，不会自动交易`,
        },
      ],
    },
  );

  return withSignature(
    {
      msg_type: 'interactive',
      card: {
        config: { wide_screen_mode: true },
        header: {
          template: opportunity.actionable ? 'red' : 'orange',
          title: { tag: 'plain_text', content: `${options.title} · ${opportunity.assetCode}` },
        },
        elements: details,
      },
    },
    timestamp,
    options.secret,
  );
}

export function buildFeishuTestPayload(
  options: { title: string; secret?: string; timestamp?: number },
): FeishuPayload {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1_000);
  return withSignature(
    {
      msg_type: 'interactive',
      card: {
        config: { wide_screen_mode: true },
        header: {
          template: 'green',
          title: { tag: 'plain_text', content: `${options.title} · 连接测试` },
        },
        elements: [
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: '飞书机器人配置成功，bStock 双边价格监听器可以发送套利告警。',
            },
          },
          {
            tag: 'note',
            elements: [{ tag: 'plain_text', content: new Date(timestamp * 1_000).toISOString() }],
          },
        ],
      },
    },
    timestamp,
    options.secret,
  );
}

async function postFeishuWebhook(url: string, payload: FeishuPayload): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(5_000),
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  });
  const responseText = await response.text();
  let result: FeishuWebhookResponse | undefined;
  try {
    result = JSON.parse(responseText) as FeishuWebhookResponse;
  } catch {
    // Preserve the HTTP error below; a successful custom-bot response must be JSON.
  }
  const code = result?.code ?? result?.StatusCode;
  const retryAfterSeconds = Number(
    response.headers.get('x-ogw-ratelimit-reset') ?? response.headers.get('retry-after') ?? '0',
  );
  const retryAfterMs =
    Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1_000 : 1_000;
  const retryable =
    response.status === 429 || response.status >= 500 || code === 11232 || code === 99991400;
  if (!response.ok) {
    throw new FeishuWebhookError(
      `Feishu webhook returned HTTP ${response.status}${code === undefined ? '' : `, code=${code}`}`,
      retryable,
      retryAfterMs,
    );
  }
  if (!result) throw new Error('Feishu webhook returned a non-JSON response');
  if (code !== 0) {
    const message = result.msg ?? result.StatusMessage ?? 'unknown error';
    throw new FeishuWebhookError(
      `Feishu webhook rejected the message: code=${String(code)}, message=${message}`,
      retryable,
      retryAfterMs,
    );
  }
}

async function waitForRateSlot(state: FeishuQueueState): Promise<void> {
  while (true) {
    const now = Date.now();
    state.sentAt = state.sentAt.filter((timestamp) => now - timestamp < 60_000);
    const lastRequestAt = state.sentAt.at(-1) ?? 0;
    const perSecondDelay = Math.max(0, lastRequestAt + MIN_REQUEST_INTERVAL_MS - now);
    const perMinuteDelay =
      state.sentAt.length >= MAX_REQUESTS_PER_MINUTE
        ? Math.max(0, state.sentAt[0]! + 60_000 - now)
        : 0;
    const delay = Math.max(perSecondDelay, perMinuteDelay);
    if (delay === 0) {
      state.sentAt.push(now);
      return;
    }
    await sleep(delay);
  }
}

async function postWithRetry(
  state: FeishuQueueState,
  url: string,
  payload: FeishuPayload,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await waitForRateSlot(state);
    try {
      await postFeishuWebhook(url, payload);
      return;
    } catch (error) {
      const retryable =
        error instanceof FeishuWebhookError
          ? error.retryable
          : error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError');
      if (!retryable || attempt === 2) throw error;
      const retryAfterMs = error instanceof FeishuWebhookError ? error.retryAfterMs : 0;
      await sleep(Math.max(retryAfterMs, 500 * 2 ** attempt));
    }
  }
}

function enqueueFeishuWebhook(url: string, payload: FeishuPayload): Promise<void> {
  const state = queueByUrl.get(url) ?? { tail: Promise.resolve(), pending: 0, sentAt: [] };
  if (!queueByUrl.has(url)) queueByUrl.set(url, state);
  if (state.pending >= MAX_PENDING_MESSAGES) {
    return Promise.reject(new Error(`Feishu webhook queue is full (${MAX_PENDING_MESSAGES} messages)`));
  }
  state.pending += 1;
  const work = state.tail.catch(() => undefined).then(() => postWithRetry(state, url, payload));
  state.tail = work.catch(() => undefined);
  return work.finally(() => {
    state.pending -= 1;
  });
}

export async function sendFeishuOpportunity(
  config: AppConfig,
  logger: Logger,
  opportunity: Opportunity,
): Promise<void> {
  if (!config.feishuWebhookUrl) return;
  const payload = buildFeishuOpportunityPayload(opportunity, {
    title: config.feishuMessageTitle,
    atAll: config.feishuAtAll,
    ...(config.feishuWebhookSecret ? { secret: config.feishuWebhookSecret } : {}),
  });
  await enqueueFeishuWebhook(config.feishuWebhookUrl, payload);
  logger.debug(
    { assetCode: opportunity.assetCode, direction: opportunity.direction },
    'Delivered arbitrage alert to Feishu',
  );
}

export async function sendFeishuTest(config: AppConfig): Promise<void> {
  if (!config.feishuWebhookUrl) throw new Error('FEISHU_WEBHOOK_URL is not configured');
  const payload = buildFeishuTestPayload({
    title: config.feishuMessageTitle,
    ...(config.feishuWebhookSecret ? { secret: config.feishuWebhookSecret } : {}),
  });
  await enqueueFeishuWebhook(config.feishuWebhookUrl, payload);
}
