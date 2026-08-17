/**
 * Enterprise RAG Chat Handler -- EdgeOne Makers (TypeScript)
 *
 * File path agents/chat/index.ts maps to POST /chat.
 * Streams OpenAI-compatible chat/completions responses, executes the
 * `query_knowledge_base` RAG tool, and persists conversation memory.
 */

import { getModelConfig } from '../_model';
import { createLogger } from '../_logger';
import { ChatSession } from '../_session';
import { buildTools, stringifyResult } from '../_tools';

const logger = createLogger('chat');
const encoder = new TextEncoder();
const MAX_TOOL_ROUNDS = 4;

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',
};

const SYSTEM_PROMPT = [
  'You are an enterprise knowledge base assistant running inside an EdgeOne Makers environment.',
  'Your objective is to answer user questions with accurate, grounded information retrieved directly from the Qdrant Cloud knowledge base.',
  '',
  'Retrieval Workflow:',
  '1. When the user asks a question, call the `query_knowledge_base(query)` tool to perform Qdrant search followed by Voyage AI reranking.',
  '2. Base your final answer strictly on the top-ranked parent section Markdown contents returned by the tool.',
  '3. Respond clearly in the same language as the user\'s question.',
  '4. Do NOT insert inline citations like [Doc, p.3] into your prose answer text; the UI automatically renders verified citation source cards separately below your response.',
  '5. If the retrieved sections do not contain enough information to answer the question, state that clearly without inventing facts or prior assumptions.',
  '6. Never invent document names, page numbers, citations, or unsupported facts.',
].join('\n');

type ChatMessage = Record<string, any>;
type ToolRegistry = ReturnType<typeof buildTools>;

interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface ToolCallAcc {
  id: string;
  name: string;
  arguments: string;
}

interface StreamChunk {
  contentDelta?: string;
  toolCalls?: ToolCallAcc[];
  usage?: Usage;
}

function sseFrame(event: string, data: Record<string, unknown>): string {
  // We include `type` inside data so both data: {...} and event: ... consumers work flawlessly
  const payload = { type: event, ...data };
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function sendEvent(
  controller: ReadableStreamDefaultController<Uint8Array>,
  event: string,
  data: Record<string, unknown>,
) {
  controller.enqueue(encoder.encode(sseFrame(event, data)));
}

function sseResponse(event: string, data: Record<string, unknown>): Response {
  const body = sseFrame(event, data) + sseFrame('finish', { stopped: false });
  return new Response(encoder.encode(body), { status: 200, headers: SSE_HEADERS });
}

function buildPayload(model: string, messages: ChatMessage[], toolRegistry: ToolRegistry): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model,
    messages,
    stream: true,
  };

  if (toolRegistry.hasTools()) {
    payload.tools = toolRegistry.tools;
    payload.tool_choice = 'auto';
  }

  return payload;
}

function assistantToolMessage(content: string, toolCalls: ToolCallAcc[]): ChatMessage {
  return {
    role: 'assistant',
    content: content || null,
    tool_calls: toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: {
        name: tc.name,
        arguments: tc.arguments,
      },
    })),
  };
}

async function* parseStreamWithTools(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';
  const toolCallsAcc = new Map<number, ToolCallAcc>();

  try {
    while (true) {
      if (signal?.aborted) return;

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;

        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') {
          if (toolCallsAcc.size > 0) {
            yield { toolCalls: Array.from(toolCallsAcc.values()) };
          }
          return;
        }

        let parsed: any;
        try {
          parsed = JSON.parse(dataStr);
        } catch {
          continue;
        }

        const choice = parsed.choices?.[0];
        if (parsed.usage) {
          yield { usage: parsed.usage };
        }

        if (!choice) continue;

        const delta = choice.delta;
        if (!delta) continue;

        if (delta.content) {
          yield { contentDelta: delta.content };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const existing = toolCallsAcc.get(idx) || {
              id: tc.id || '',
              name: tc.function?.name || '',
              arguments: '',
            };

            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name = tc.function.name;
            if (tc.function?.arguments) existing.arguments += tc.function.arguments;

            toolCallsAcc.set(idx, existing);
          }
        }
      }
    }

    if (toolCallsAcc.size > 0) {
      yield { toolCalls: Array.from(toolCallsAcc.values()) };
    }
  } finally {
    reader.releaseLock();
  }
}

async function streamModelRound(params: {
  url: string;
  apiKey: string;
  payload: Record<string, unknown>;
  round: number;
  signal?: AbortSignal;
  controller: ReadableStreamDefaultController<Uint8Array>;
  onTextDelta: (delta: string) => void;
}): Promise<{
  content: string;
  toolCalls?: ToolCallAcc[];
  stopped: boolean;
  failed: boolean;
}> {
  const { url, apiKey, payload, signal, controller, onTextDelta } = params;

  let content = '';
  let toolCalls: ToolCallAcc[] | undefined;
  let stopped = false;
  let failed = false;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    const detail = await response.text();
    logger.error(`LLM gateway error HTTP ${response.status}:`, detail);
    sendEvent(controller, 'error', {
      errorText: `LLM gateway error HTTP ${response.status}: ${detail}`,
    });
    return { content, toolCalls, stopped, failed: true };
  }

  for await (const chunk of parseStreamWithTools(response, signal)) {
    if (signal?.aborted) {
      stopped = true;
      break;
    }

    if (chunk.contentDelta) {
      content += chunk.contentDelta;
      onTextDelta(chunk.contentDelta);
    }
    if (chunk.toolCalls) {
      toolCalls = chunk.toolCalls;
    }
  }

  return { content, toolCalls, stopped, failed };
}

function emitToolCallEvents(
  controller: ReadableStreamDefaultController<Uint8Array>,
  toolCalls: ToolCallAcc[],
) {
  for (const tc of toolCalls) {
    sendEvent(controller, 'tool-input-available', {
      toolCallId: tc.id,
      toolName: tc.name,
      input: tc.arguments,
    });
    sendEvent(controller, 'tool_called', { tool: tc.name });
  }
}

async function executeToolCalls(params: {
  toolRegistry: ToolRegistry;
  toolCalls: ToolCallAcc[];
  controller: ReadableStreamDefaultController<Uint8Array>;
}): Promise<string[]> {
  const { toolRegistry, toolCalls, controller } = params;

  return await Promise.all(
    toolCalls.map(async (tc) => {
      const raw = await toolRegistry.executeRaw(tc.name, tc.arguments);
      const result = stringifyResult(raw);

      sendEvent(controller, 'tool-output-available', {
        toolCallId: tc.id,
        toolName: tc.name,
        output: result,
      });

      return result;
    }),
  );
}

function appendToolResults(messages: ChatMessage[], toolCalls: ToolCallAcc[], results: string[]) {
  for (let i = 0; i < toolCalls.length; i++) {
    logger.log(`[tool] ${toolCalls[i].name} returned ${results[i].length} chars`);
    messages.push({
      role: 'tool',
      tool_call_id: toolCalls[i].id,
      content: results[i],
    });
  }
}

async function loadHistoryAndSaveUser(
  context: any,
  session: ChatSession,
  cid: string,
  message: string,
): Promise<ChatMessage[]> {
  if (!cid) return [];
  const history = await session.getHistory(cid);
  await session.saveUserMessage(cid, message);
  return history;
}

export async function onRequest(context: any) {
  const cid: string =
    context.conversation_id ||
    context.request?.headers?.get?.('makers-conversation-id') ||
    '';

  let rawMessage = '';
  try {
    if (context.request?.body?.message) {
      rawMessage = context.request.body.message;
    } else if (typeof context.request?.json === 'function') {
      const body = await context.request.json().catch(() => ({}));
      rawMessage = body?.message || '';
    }
  } catch {
    rawMessage = '';
  }

  logger.log(`[handler] conversation_id: ${cid}`);

  if (typeof rawMessage !== 'string' || rawMessage.trim().length === 0) {
    return sseResponse('error', { errorText: 'message is required' });
  }

  const message = rawMessage.slice(0, 10000);
  const signal: AbortSignal | undefined = context.request?.signal;
  const session = new ChatSession(context.agent?.store || context.store);
  const history = await loadHistoryAndSaveUser(context, session, cid, message);
  const toolRegistry = buildTools(context, logger);

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: message },
  ];

  const modelConfig = getModelConfig(context.env || process.env);
  const url = `${modelConfig.baseUrl.replace(/\/$/, '')}/chat/completions`;
  logger.log(`[handler] streaming from: ${url}, model: ${modelConfig.model}`);

  let assistantContent = '';
  let stopped = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      if (!modelConfig.apiKey || !modelConfig.baseUrl) {
        sendEvent(controller, 'error', {
          errorText: 'AI Gateway not configured. Set AI_GATEWAY_API_KEY and AI_GATEWAY_BASE_URL.',
        });
        controller.close();
        return;
      }

      // Send initial start event
      sendEvent(controller, 'start', { messageId: cid });

      try {
        for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
          if (signal?.aborted) {
            stopped = true;
            break;
          }

          const payload = buildPayload(modelConfig.model, messages, toolRegistry);
          logger.log(`[handler] round ${round}, messages: ${messages.length}`);

          const result = await streamModelRound({
            url,
            apiKey: modelConfig.apiKey,
            payload,
            round,
            signal,
            controller,
            onTextDelta(delta) {
              assistantContent += delta;
              sendEvent(controller, 'text-delta', { delta });
            },
          });

          stopped = result.stopped;
          if (stopped || result.failed) break;
          if (!result.toolCalls?.length) break;

          messages.push(assistantToolMessage(result.content, result.toolCalls));
          emitToolCallEvents(controller, result.toolCalls);

          const toolResults = await executeToolCalls({
            toolRegistry,
            toolCalls: result.toolCalls,
            controller,
          });
          appendToolResults(messages, result.toolCalls, toolResults);
        }
      } catch (e: unknown) {
        const error = e as Error;
        if (error.name === 'AbortError' || signal?.aborted) {
          stopped = true;
          logger.log('[stream] aborted by user');
        } else {
          logger.error('[stream] error:', error.message, error.stack);
          sendEvent(controller, 'error', {
            errorText: String(error.message ?? e),
          });
        }
      } finally {
        if (assistantContent && cid) {
          try {
            await session.saveAssistantMessage(cid, assistantContent);
          } catch (err) {
            logger.warn('Failed to persist assistant message:', err);
          }
        }

        sendEvent(controller, 'finish', { stopped });
        controller.close();
      }
    },
    cancel() {
      logger.log('[stream] client disconnected');
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}
