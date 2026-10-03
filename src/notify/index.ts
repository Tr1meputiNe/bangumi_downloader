import type { NotifyConfig } from '../config.js';
import { fetchText } from '../trackers/http.js';
import { logger } from '../util/log.js';

const log = logger('notify');

export type NotifyPayload = {
  title: string;
  body: string;
};

/**
 * 通知。默认只写日志；配置了 Server 酱或 Telegram 时额外推送。
 * 通知失败永远不影响主流程。
 */
export async function notify(config: NotifyConfig, payload: NotifyPayload): Promise<void> {
  const tasks: Array<Promise<unknown>> = [];

  if (config.serverChanKey) {
    tasks.push(sendServerChan(config.serverChanKey, payload));
  }
  if (config.telegram?.botToken && config.telegram.chatId) {
    tasks.push(sendTelegram(config.telegram, payload));
  }

  if (tasks.length === 0) return;
  await Promise.allSettled(tasks);
}

async function sendServerChan(key: string, payload: NotifyPayload): Promise<void> {
  const match = /^sctp(\d+)t/i.exec(key.trim());
  const url = match
    ? `https://${match[1]}.push.ft07.com/send/${key.trim()}.send`
    : `https://sctapi.ftqq.com/${key.trim()}.send`;
  const body = new URLSearchParams({ title: payload.title, desp: payload.body });
  const text = await fetchText(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    retries: 1
  });
  if (text === null) log.warn('Server 酱通知发送失败');
}

async function sendTelegram(telegram: { botToken: string; chatId: string }, payload: NotifyPayload): Promise<void> {
  const text = `*${escapeMarkdown(payload.title)}*\n\n${escapeMarkdown(payload.body)}`;
  const text2 = await fetchText(`https://api.telegram.org/bot${telegram.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: telegram.chatId,
      text,
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true
    }),
    retries: 1
  });
  if (text2 === null) log.warn('Telegram 通知发送失败');
}

function escapeMarkdown(value: string): string {
  return value.replace(/[_*[\]()~`>#+\-=|{}.!]/g, (char) => `\\${char}`);
}
