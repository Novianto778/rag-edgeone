/**
 * POST & GET /list-documents — EdgeOne Makers Node Cloud Function.
 *
 * Lists all uploaded and indexed documents from EdgeOne Pages Blob Storage (@edgeone/pages-blob)
 * and Qdrant Cloud.
 */

import { getStore } from '@edgeone/pages-blob';
import { createLogger } from '../_logger';
import { listIndexedDocumentsFromQdrant } from '../../agents/_qdrant';

const logger = createLogger('list-documents');

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function getBlobStore() {
  const storeName = process.env.BLOB_STORE_NAME || 'uploads';
  return getStore(storeName);
}

interface CatalogItem {
  docId: string;
  docName: string;
  storedName: string;
  fileSize: number;
  uploadedAt: string;
  type: string;
  status: string;
  chunkCount?: number;
}

async function getDocumentList(): Promise<CatalogItem[]> {
  const docMap = new Map<string, CatalogItem>();

  // 1. Fetch metadata records from EdgeOne Pages Blob Storage (@edgeone/pages-blob)
  try {
    const blobStore = getBlobStore();
    const listRes = await blobStore.list({ prefix: 'metadata/' });

    if (listRes?.blobs && listRes.blobs.length > 0) {
      for (const blob of listRes.blobs) {
        try {
          const meta = await blobStore.get(blob.key, { type: 'json' });
          if (meta && meta.docId) {
            const isDocx = (meta.docName || meta.storedName || '').toLowerCase().endsWith('.docx');
            docMap.set(meta.docId, {
              docId: meta.docId,
              docName: meta.docName || meta.storedName || meta.docId,
              storedName: meta.storedName || `${meta.docId}${isDocx ? '.docx' : '.pdf'}`,
              fileSize: meta.fileSize || 0,
              uploadedAt: meta.uploadedAt || new Date().toISOString(),
              type: isDocx ? 'DOCX' : 'PDF',
              status: 'ready',
              chunkCount: meta.childChunks || meta.parentSections || 0,
            });
          }
        } catch (itemErr) {
          logger.warn(`Failed to parse blob metadata for ${blob.key}:`, itemErr);
        }
      }
    }
  } catch (blobErr) {
    logger.warn('EdgeOne Blob Storage list notice:', blobErr);
  }

  // 2. Fetch / sync indexed documents from Qdrant Cloud
  try {
    const qdrantDocs = await listIndexedDocumentsFromQdrant();
    for (const qd of qdrantDocs) {
      const isDocx = qd.docName.toLowerCase().endsWith('.docx');
      if (docMap.has(qd.docId)) {
        const existing = docMap.get(qd.docId)!;
        if (qd.chunkCount) existing.chunkCount = qd.chunkCount;
      } else {
        docMap.set(qd.docId, {
          docId: qd.docId,
          docName: qd.docName,
          storedName: `${qd.docId}${isDocx ? '.docx' : '.pdf'}`,
          fileSize: 0,
          uploadedAt: qd.uploadedAt || new Date().toISOString(),
          type: isDocx ? 'DOCX' : 'PDF',
          status: 'ready',
          chunkCount: qd.chunkCount,
        });
      }
    }
  } catch (qErr) {
    logger.warn('Failed to retrieve documents from Qdrant:', qErr);
  }

  const documents = Array.from(docMap.values());
  documents.sort((a, b) => (b.uploadedAt || '').localeCompare(a.uploadedAt || ''));

  logger.log(`list-documents returning ${documents.length} document(s)`);
  return documents;
}

export async function onRequestPost(): Promise<Response> {
  try {
    const documents = await getDocumentList();
    return jsonResponse({ status: 'success', documents });
  } catch (e: any) {
    logger.error('list-documents handler failed:', e);
    return jsonResponse({ error: `Failed to list documents: ${e.message || String(e)}` }, 500);
  }
}

export async function onRequestGet(): Promise<Response> {
  try {
    const documents = await getDocumentList();
    return jsonResponse({ status: 'success', documents });
  } catch (e: any) {
    logger.error('list-documents handler failed:', e);
    return jsonResponse({ error: `Failed to list documents: ${e.message || String(e)}` }, 500);
  }
}
