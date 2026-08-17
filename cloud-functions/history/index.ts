/**
 * History handler — EdgeOne Makers Node Function
 *
 * File path cloud-functions/history/index.ts maps to POST /history and GET /history.
 */

import { createLogger } from '../_logger';

const logger = createLogger('history');

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;

interface MemoryMessage {
  messageId?: string;
  role?: string;
  content?: unknown;
  createdAt?: number;
  metadata?: Record<string, unknown>;
}

interface FrontendMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

async function readJsonBody(context: any): Promise<Record<string, unknown>> {
  try {
    const data = await context.request.json();
    return data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function getConversationId(context: any, body: Record<string, unknown>): string {
  const fromBody = body.conversation_id ?? body.conversationId;
  if (typeof fromBody === 'string' && fromBody.trim()) return fromBody.trim();

  try {
    const headerValue = context?.request?.headers?.get?.('makers-conversation-id');
    if (typeof headerValue === 'string' && headerValue.trim()) return headerValue.trim();
  } catch {
    /* noop */
  }

  try {
    const url = new URL(context.request.url);
    const fromUrl = url.searchParams.get('conversation_id') || url.searchParams.get('conversationId');
    if (fromUrl) return fromUrl.trim();
  } catch {
    /* noop */
  }

  return '';
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;

  if (content !== null && typeof content === 'object' && !Array.isArray(content)) {
    const obj = content as Record<string, unknown>;
    if ('content' in obj) return contentToText(obj.content);
    if ('output' in obj) return contentToText(obj.output);
    if ('text' in obj) return String(obj.text ?? '');
    return '';
  }

  if (Array.isArray(content)) {
    return content
      .filter((item): item is Record<string, unknown> =>
        item !== null && typeof item === 'object',
      )
      .map((item) => String(item.text ?? item.output_text ?? ''))
      .filter(Boolean)
      .join('\n');
  }

  return String(content);
}

async function handleHistory(context: any): Promise<Response> {
  const startTime = Date.now();
  logger.log(`[history] start: ${new Date(startTime).toISOString()}`);

  const body = await readJsonBody(context);
  const conversationId = getConversationId(context, body);
  const store = context.agent?.store || context.store;

  logger.log('conversationId:', conversationId || '-');

  if (!conversationId || !store?.getMessages) {
    logger.log(
      `[history] end: ${new Date().toISOString()}, total: ${Date.now() - startTime}ms (no conversationId or store)`,
    );
    return jsonResponse({ conversation_id: conversationId, messages: [] });
  }

  try {
    const history: MemoryMessage[] = await store.getMessages({
      conversationId,
      limit: 100,
      order: 'asc',
    });

    const messages: FrontendMessage[] = [];
    for (const item of history || []) {
      const role = item.role;
      if (role !== 'user' && role !== 'assistant') continue;

      const content = contentToText(item.content);
      if (!content) continue;

      messages.push({
        id: item.messageId ?? `${role}-${item.createdAt ?? 0}`,
        role: role as 'user' | 'assistant',
        content,
        timestamp: item.createdAt ?? 0,
      });
    }

    logger.log(
      `[history] end: ${new Date().toISOString()}, total: ${Date.now() - startTime}ms (returned ${messages.length} messages)`,
    );
    return jsonResponse({ conversation_id: conversationId, messages });
  } catch (e) {
    logger.error('failed to get messages:', e);
    logger.log(`[history] end: ${new Date().toISOString()}, total: ${Date.now() - startTime}ms (error)`);
    return jsonResponse({ conversation_id: conversationId, messages: [] });
  }
}

export async function onRequestPost(context: any): Promise<Response> {
  return handleHistory(context);
}

export async function onRequestGet(context: any): Promise<Response> {
  return handleHistory(context);
}
