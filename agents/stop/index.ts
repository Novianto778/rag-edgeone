/**
 * Stop handler -- EdgeOne Makers
 * Maps to POST /stop
 */

import { createLogger } from '../_logger';

const logger = createLogger('stop');

export async function onRequest(context: any) {
  let conversationId: string | undefined;

  try {
    if (context.request?.body?.conversation_id) {
      conversationId = context.request.body.conversation_id;
    } else if (context.request?.body?.conversationId) {
      conversationId = context.request.body.conversationId;
    } else if (typeof context.request?.json === 'function') {
      const body = await context.request.json().catch(() => ({}));
      conversationId = body?.conversation_id || body?.conversationId;
    }
  } catch {
    conversationId = undefined;
  }

  logger.log('conversationId to stop:', conversationId);

  if (!conversationId) {
    return new Response(JSON.stringify({ error: 'Missing conversation_id' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    });
  }

  const ret = context.utils?.abortActiveRun?.(conversationId);
  logger.log('abortActiveRun result:', ret);

  const data = {
    status: ret?.aborted ? 'aborting' : 'idle',
    conversationId,
    ...ret,
  };

  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
  });
}
