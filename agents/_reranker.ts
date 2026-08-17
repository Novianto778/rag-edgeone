/**
 * Voyage AI Reranking & Parent Section Resolution Module for TypeScript.
 *
 * Calls Voyage AI Rerank REST API directly to score candidate child passages,
 * deduplicates parent IDs, and returns unique Top-5 Parent Sections for LLM context.
 */

import { createLogger } from './_logger';
import type { CandidateChunk } from './_qdrant';

const logger = createLogger('reranker');

function getVoyageApiKey(): string {
  return process.env.VOYAGE_API_KEY || '';
}

const VOYAGE_RERANK_URL = 'https://api.voyageai.com/v1/rerank';

export interface ResolvedParentSection {
  docId: string;
  docName: string;
  parentId: string;
  sectionPath: string;
  content: string;
  rerankScore: number;
}

/**
 * Rerank candidates using Voyage AI REST API and resolve unique parent sections.
 */
export async function rerankAndResolveParentSections(
  query: string,
  candidateChunks: CandidateChunk[],
  maxParentSections = 5,
): Promise<ResolvedParentSection[]> {
  if (!candidateChunks || candidateChunks.length === 0) {
    return [];
  }

  let rankedCandidates = [...candidateChunks];
  const apiKey = getVoyageApiKey();

  if (apiKey) {
    try {
      const passages = candidateChunks.map((c) => c.child_text);
      const payload = {
        query,
        documents: passages,
        model: 'rerank-2',
        top_k: passages.length,
        return_documents: false,
      };

      const resp = await fetch(VOYAGE_RERANK_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (resp.ok) {
        const data = (await resp.json()) as {
          data?: Array<{ index: number; relevance_score: number }>;
        };

        if (Array.isArray(data?.data)) {
          rankedCandidates = data.data.map((r) => {
            const orig = candidateChunks[r.index];
            return {
              ...orig,
              score: Number(r.relevance_score),
            };
          });
          logger.log(`Voyage AI Reranked ${passages.length} passages successfully.`);
        }
      } else {
        logger.warn(`Voyage AI Rerank HTTP ${resp.status}: ${await resp.text()}`);
      }
    } catch (e) {
      logger.warn('Voyage AI Rerank API notice (fallback to vector search order):', e);
    }
  }

  // Deduplicate & Resolve Parent Sections
  const seenParentIds = new Set<string>();
  const parentSections: ResolvedParentSection[] = [];

  for (const item of rankedCandidates) {
    const parentId = item.parent_id;
    if (!parentId || seenParentIds.has(parentId)) {
      continue;
    }

    seenParentIds.add(parentId);
    parentSections.push({
      docId: item.doc_id || '',
      docName: item.doc_name || '',
      parentId,
      sectionPath: item.section_path || '',
      content: item.parent_text || '',
      rerankScore: item.score || 0,
    });

    if (parentSections.length >= maxParentSections) {
      break;
    }
  }

  logger.log(`Resolved ${parentSections.length} unique parent section(s) for LLM context.`);
  return parentSections;
}
