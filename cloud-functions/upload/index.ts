/**
 * POST /upload — EdgeOne Makers Node Cloud Function.
 *
 * Receives raw PDF/DOCX files, stores them in EdgeOne Blob Storage (context.store),
 * parses them in-memory to Markdown via Firecrawl SDK v2, runs Parent-Child chunking,
 * and indexes them into Qdrant Cloud.
 */

import * as path from 'node:path';
import { createLogger } from '../_logger';
import { parseDocumentToMarkdownViaFirecrawl } from '../../agents/_parser';
import {
  splitMarkdownIntoParentSections,
  createChildChunksFromParents,
} from '../../agents/_chunker';
import { upsertChildChunksToQdrant } from '../../agents/_qdrant';

const logger = createLogger('upload');

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

export async function onRequestPost(context: any): Promise<Response> {
  const startTime = Date.now();
  logger.log(`[upload] Request started at ${new Date(startTime).toISOString()}`);

  try {
    const contentType = context.request?.headers?.get?.('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      return jsonResponse({ error: 'Content-Type must be multipart/form-data' }, 400);
    }

    const formData = await context.request.formData();
    const file = formData.get('file');

    if (!file || typeof file === 'string') {
      return jsonResponse({ error: 'No file parameter found in multipart upload' }, 400);
    }

    const fileObj = file as File;
    const originalName = fileObj.name || 'document.pdf';
    const fileSize = fileObj.size;

    const fileBuffer = Buffer.from(await fileObj.arrayBuffer());
    if (fileBuffer.length === 0) {
      return jsonResponse({ error: 'Uploaded file is empty' }, 400);
    }

    const docId = `doc_${Date.now()}`;
    const ext = path.extname(originalName).toLowerCase() || '.pdf';
    const storedFilename = `${docId}${ext}`;
    const blobKey = `uploads/${storedFilename}`;

    // 1. Persist to EdgeOne Pages Blob Store (context.store)
    try {
      const store = context.store || context.agent?.store;
      if (store?.put) {
        await store.put(blobKey, fileBuffer);
        logger.log(`Persisted to EdgeOne store via put: ${blobKey}`);
      } else if (store?.set) {
        await store.set(blobKey, fileBuffer);
        logger.log(`Persisted to EdgeOne store via set: ${blobKey}`);
      }
    } catch (storeErr) {
      logger.warn('context.store persistence notice:', storeErr);
    }

    // 2. Parse in-memory via Firecrawl SDK v2 (No local disk write required)
    logger.log(`Parsing ${originalName} in-memory via Firecrawl...`);
    const markdownText = await parseDocumentToMarkdownViaFirecrawl(fileBuffer, originalName);

    // 3. Section-Aware Parent-Child Chunking
    logger.log('Performing Parent-Child hierarchical chunking...');
    const parentSections = splitMarkdownIntoParentSections(markdownText, docId, originalName);
    const childChunks = createChildChunksFromParents(parentSections);
    logger.log(`Generated ${parentSections.length} parent sections and ${childChunks.length} child chunks.`);

    // 4. Qdrant Cloud Vector Indexing
    logger.log('Upserting child chunks to Qdrant Cloud with Mistral Embed dense vectors...');
    const upsertedPoints = await upsertChildChunksToQdrant(childChunks);

    const duration = Date.now() - startTime;
    logger.log(`[upload] Succeeded in ${duration}ms. Ingested ${upsertedPoints} points.`);

    return jsonResponse({
      status: 'success',
      docId,
      fileName: originalName,
      storedName: storedFilename,
      fileSize,
      uploadedAt: new Date().toISOString(),
      path: blobKey,
      blobKey,
      parentSections: parentSections.length,
      childChunks: childChunks.length,
      qdrantPoints: upsertedPoints,
    });
  } catch (e: any) {
    logger.error('[upload] Ingestion pipeline failed:', e);
    return jsonResponse({ error: `Ingestion pipeline failed: ${e.message || String(e)}` }, 500);
  }
}
