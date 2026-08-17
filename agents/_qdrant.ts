/**
 * Qdrant Cloud & Hybrid Vector Search Integration Module for TypeScript.
 *
 * Handles dense vector embeddings (Mistral Embed), Qdrant collection setup,
 * point upserts with Parent-Child payloads, candidate search, and document deletions.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { createHash } from 'node:crypto';
import { createLogger } from './_logger';
import type { ChildChunk } from './_chunker';

const logger = createLogger('qdrant');

function getCollectionName(): string {
  return process.env.QDRANT_COLLECTION || 'hr_rag_knowledge_base';
}

function getQdrantUrl(): string {
  return process.env.QDRANT_URL || process.env.QDRANT_CLUSTER_ENDPOINT || '';
}

function getQdrantApiKey(): string {
  return process.env.QDRANT_API_KEY || '';
}

function getMistralApiKey(): string {
  return process.env.MISTRAL_API_KEY || '';
}

let _qdrantClient: QdrantClient | null = null;
let _collectionChecked = false;

export interface CandidateChunk {
  id: string;
  score: number;
  doc_id: string;
  doc_name: string;
  parent_id: string;
  parent_text: string;
  child_text: string;
  section_path: string;
}

/**
 * Lazy initialize Qdrant Client.
 */
export function getQdrantClient(): QdrantClient | null {
  if (_qdrantClient) {
    return _qdrantClient;
  }

  try {
    const url = getQdrantUrl();
    const apiKey = getQdrantApiKey();

    if (url) {
      logger.log(`Connecting to Qdrant Cloud cluster: ${url}`);
      _qdrantClient = new QdrantClient({
        url,
        apiKey: apiKey || undefined,
        checkCompatibility: false,
      });
    } else {
      logger.warn('No Qdrant Cloud URL configured in environment variables.');
      return null;
    }
    return _qdrantClient;
  } catch (e) {
    logger.error('Failed to initialize QdrantClient:', e);
    return null;
  }
}

/**
 * Generate 1024-dim dense vector embedding using Mistral Embed REST API or fallback vector.
 */
export async function generateDenseEmbedding(text: string): Promise<number[]> {
  const mistralKey = getMistralApiKey();

  if (mistralKey) {
    try {
      const resp = await fetch('https://api.mistral.ai/v1/embeddings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${mistralKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'mistral-embed',
          input: [text],
        }),
      });

      if (resp.ok) {
        const data = (await resp.json()) as any;
        if (data?.data?.[0]?.embedding) {
          return data.data[0].embedding;
        }
      } else {
        logger.error(`Mistral Embed API error HTTP ${resp.status}: ${await resp.text()}`);
      }
    } catch (e) {
      logger.error('Mistral Embed generation failed:', e);
    }
  }

  // Fallback 1024-dim deterministic pseudo-vector
  const hash = createHash('sha256').update(text).digest();
  const dim = 1024;
  const vec: number[] = [];
  for (let i = 0; i < dim; i++) {
    const byte = hash[i % hash.length];
    vec.push(byte / 255.0 - 0.5);
  }
  return vec;
}

/**
 * Ensure Qdrant collection exists with dense vector configs.
 */
export async function ensureCollectionExists(): Promise<void> {
  if (_collectionChecked) return;
  const client = getQdrantClient();
  if (!client) return;

  const collectionName = getCollectionName();

  try {
    const existsRes = await client.collectionExists(collectionName);
    if (!existsRes?.exists) {
      logger.log(`Creating Qdrant collection: ${collectionName}`);
      await client.createCollection(collectionName, {
        vectors: {
          size: 1024,
          distance: 'Cosine',
        },
      });

      // Create payload indexes for filtering
      try {
        await client.createPayloadIndex(collectionName, {
          field_name: 'doc_id',
          field_schema: 'keyword',
        });
        await client.createPayloadIndex(collectionName, {
          field_name: 'section_path',
          field_schema: 'keyword',
        });
      } catch (idxErr) {
        logger.warn('Payload index creation notice:', idxErr);
      }
    }
    _collectionChecked = true;
  } catch (e) {
    logger.error('ensureCollectionExists failed:', e);
  }
}

/**
 * Upsert child chunks into Qdrant Cloud with dense vectors and payloads.
 */
export async function upsertChildChunksToQdrant(childChunks: ChildChunk[]): Promise<number> {
  const client = getQdrantClient();
  if (!client || !childChunks || childChunks.length === 0) {
    return 0;
  }

  await ensureCollectionExists();
  const collectionName = getCollectionName();

  try {
    const points: any[] = [];

    // Process embeddings in batches
    const batchSize = 10;
    for (let i = 0; i < childChunks.length; i += batchSize) {
      const batch = childChunks.slice(i, i + batchSize);
      const embeddings = await Promise.all(
        batch.map((chunk) => generateDenseEmbedding(chunk.child_text))
      );

      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j];
        const denseVec = embeddings[j];

        points.push({
          id: chunk.child_id,
          vector: denseVec,
          payload: {
            doc_id: chunk.doc_id,
            doc_name: chunk.doc_name,
            parent_id: chunk.parent_id,
            parent_text: chunk.parent_text,
            child_id: chunk.child_id,
            child_text: chunk.child_text,
            section_path: chunk.section_path,
            child_index: chunk.child_index,
            token_count: chunk.token_count,
            uploaded_at: new Date().toISOString(),
          },
        });
      }
    }

    await client.upsert(collectionName, {
      wait: true,
      points,
    });

    logger.log(`Upserted ${points.length} child chunk points to Qdrant collection '${collectionName}'`);
    return points.length;
  } catch (e) {
    logger.error('Failed to upsert points to Qdrant:', e);
    return 0;
  }
}

/**
 * Search Qdrant and return Top-20 candidates.
 */
export async function hybridSearchQdrant(query: string, topK = 20): Promise<CandidateChunk[]> {
  const client = getQdrantClient();
  if (!client) {
    return [];
  }

  await ensureCollectionExists();
  const collectionName = getCollectionName();

  try {
    const queryDense = await generateDenseEmbedding(query);

    const searchResults = await client.query(collectionName, {
      query: queryDense,
      limit: topK,
      with_payload: true,
    });

    const candidates: CandidateChunk[] = [];
    for (const res of searchResults.points || []) {
      const payload = (res.payload as Record<string, any>) || {};
      candidates.push({
        id: String(res.id),
        score: typeof res.score === 'number' ? res.score : 0,
        doc_id: String(payload.doc_id || ''),
        doc_name: String(payload.doc_name || ''),
        parent_id: String(payload.parent_id || ''),
        parent_text: String(payload.parent_text || ''),
        child_text: String(payload.child_text || ''),
        section_path: String(payload.section_path || ''),
      });
    }

    logger.log(`hybridSearchQdrant: query="${query}" returned ${candidates.length} candidates`);
    return candidates;
  } catch (e) {
    logger.error('hybridSearchQdrant failed:', e);
    return [];
  }
}

/**
 * Delete all points associated with a specific doc_id from Qdrant.
 */
export async function deleteDocumentPoints(docId: string): Promise<boolean> {
  const client = getQdrantClient();
  if (!client || !docId) return false;

  await ensureCollectionExists();
  const collectionName = getCollectionName();

  try {
    await client.delete(collectionName, {
      wait: true,
      filter: {
        must: [
          {
            key: 'doc_id',
            match: { value: docId },
          },
        ],
      },
    });
    logger.log(`Deleted points from Qdrant collection for doc_id="${docId}"`);
    return true;
  } catch (e) {
    logger.error(`deleteDocumentPoints failed for doc_id="${docId}":`, e);
    return false;
  }
}

/**
 * Get distinct indexed document metadata list and chunk counts from Qdrant collection.
 */
export async function listIndexedDocumentsFromQdrant(): Promise<
  Array<{
    docId: string;
    docName: string;
    chunkCount: number;
    uploadedAt: string;
  }>
> {
  const client = getQdrantClient();
  if (!client) return [];

  await ensureCollectionExists();
  const collectionName = getCollectionName();

  try {
    const scrollRes = await client.scroll(collectionName, {
      limit: 500,
      with_payload: true,
      with_vector: false,
    });

    const docMap = new Map<
      string,
      { docId: string; docName: string; chunkCount: number; uploadedAt: string }
    >();

    for (const point of scrollRes.points || []) {
      const p = (point.payload as Record<string, any>) || {};
      const docId = String(p.doc_id || '');
      const docName = String(p.doc_name || docId);
      const uploadedAt = String(p.uploaded_at || '');

      if (!docId) continue;

      if (!docMap.has(docId)) {
        docMap.set(docId, {
          docId,
          docName,
          chunkCount: 1,
          uploadedAt,
        });
      } else {
        const item = docMap.get(docId)!;
        item.chunkCount += 1;
        if (!item.uploadedAt && uploadedAt) item.uploadedAt = uploadedAt;
      }
    }

    return Array.from(docMap.values());
  } catch (e) {
    logger.error('listIndexedDocumentsFromQdrant failed:', e);
    return [];
  }
}
