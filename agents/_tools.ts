/**
 * RAG & Platform Tool Definitions for EdgeOne Makers (TypeScript).
 *
 * Exposes the unified `query_knowledge_base` function calling tool
 * which executes Mistral embedding, Qdrant Cloud search (Top-20),
 * Voyage AI Rerank (rerank-2), and Parent Section deduplication.
 */

import { createLogger } from './_logger';
import { hybridSearchQdrant } from './_qdrant';
import { rerankAndResolveParentSections } from './_reranker';

const logger = createLogger('tools');

export type ToolSchema = Record<string, unknown>;

export class ToolRegistry {
  tools: ToolSchema[] = [];
  private handlers: Map<string, (args: Record<string, unknown>) => unknown> = new Map();

  hasTools(): boolean {
    return this.tools.length > 0;
  }

  register(name: string, schema: ToolSchema, handler: (args: Record<string, unknown>) => unknown): void {
    if (this.handlers.has(name)) return;
    this.tools.push(schema);
    this.handlers.set(name, handler);
  }

  async execute(name: string, arguments_: string): Promise<string> {
    const raw = await this.executeRaw(name, arguments_);
    return stringifyResult(raw);
  }

  async executeRaw(name: string, arguments_: string): Promise<unknown> {
    const handler = this.handlers.get(name);
    if (!handler) {
      return { error: `Unknown tool: ${name}` };
    }

    let args: Record<string, unknown> = {};
    try {
      args = arguments_ ? JSON.parse(arguments_) : {};
    } catch {
      args = {};
    }

    try {
      let result = handler(args);
      if (result && typeof result === 'object' && 'then' in result) {
        result = await (result as Promise<unknown>);
      }
      return result;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { error: `Tool execution failed: ${message}` };
    }
  }
}

export function stringifyResult(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/**
 * Executes the full query -> Qdrant search -> Voyage rerank -> Parent resolution pipeline.
 */
export async function executeQueryKnowledgeBase(query: string): Promise<string> {
  const q = (query || '').trim();
  logger.log(`query_knowledge_base called: query="${q}"`);

  if (!q) {
    return JSON.stringify({ error: 'Empty query string provided.' });
  }

  // 1. Qdrant Search (Top-20 Candidate Child Chunks)
  const candidateChunks = await hybridSearchQdrant(q, 20);

  if (!candidateChunks || candidateChunks.length === 0) {
    logger.warn(`No Qdrant search results found for query: "${q}"`);
    return JSON.stringify({
      type: 'citation_pages',
      query: q,
      resultsCount: 0,
      message: 'No matching knowledge base content found in Qdrant vector database.',
      content: [],
    });
  }

  // 2. Voyage AI Reranking & Parent Section Resolution (Top-5 Parent Chunks)
  const parentSections = await rerankAndResolveParentSections(q, candidateChunks, 5);

  // Format result payload for LLM context and citation rendering
  const formattedContent = parentSections.map((p, idx) => ({
    page: idx + 1,
    docId: p.docId,
    docName: p.docName,
    sectionPath: p.sectionPath,
    content: p.content,
    preview: p.content.slice(0, 400),
    rerankScore: p.rerankScore,
  }));

  const firstDocId = parentSections[0]?.docId || 'knowledge_base';
  const firstDocName = parentSections[0]?.docName || 'Knowledge Base';

  return JSON.stringify({
    type: 'citation_pages',
    docId: firstDocId,
    docName: firstDocName,
    query: q,
    pageCount: parentSections.length,
    totalChars: parentSections.reduce((acc, p) => acc + p.content.length, 0),
    content: formattedContent,
  });
}

/**
 * Build a ToolRegistry containing RAG query_knowledge_base and any optional platform tools.
 */
export function buildTools(context?: any, customLogger?: any): ToolRegistry {
  const registry = new ToolRegistry();
  const log = customLogger || logger;

  // Register RAG query_knowledge_base tool
  registry.register(
    'query_knowledge_base',
    {
      type: 'function',
      function: {
        name: 'query_knowledge_base',
        description:
          'Query the Qdrant Cloud enterprise knowledge base using vector search and Voyage AI reranking. Returns top-ranked parent section Markdown contents with citation provenance.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: "User's search question or inquiry to look up in the knowledge base",
            },
          },
          required: ['query'],
        },
      },
    },
    async (args: Record<string, unknown>) => {
      const query = String(args.query || args.q || '');
      return executeQueryKnowledgeBase(query);
    }
  );

  log.log('[tools] registered: query_knowledge_base');

  // Register any EdgeOne sandbox platform tools if present
  const runtimeTools = context?.tools;
  if (runtimeTools && typeof runtimeTools.all === 'function') {
    const rawTools = runtimeTools.all();
    for (const item of rawTools || []) {
      const name: string | undefined = item?.name ?? item?.function?.name;
      const handler = item?.execute ?? item?.handler ?? item?.invoke;

      if (!name || typeof handler !== 'function' || name === 'query_knowledge_base') {
        continue;
      }

      const description: string = item?.function?.description ?? item?.description ?? '';
      const parameters: Record<string, unknown> =
        item?.function?.parameters ??
        item?.parameters ??
        item?.inputSchema ??
        item?.input_schema ??
        { type: 'object', properties: {} };

      registry.register(
        name,
        {
          type: 'function',
          function: {
            name,
            description,
            parameters,
          },
        },
        handler
      );
      log.log(`[tools] registered platform tool: ${name}`);
    }
  }

  return registry;
}
