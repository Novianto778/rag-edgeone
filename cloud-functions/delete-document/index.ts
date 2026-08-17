/**
 * POST & DELETE /delete-document — EdgeOne Makers Node Cloud Function.
 *
 * Deletes objects from EdgeOne Pages Blob Storage (@edgeone/pages-blob) and points from Qdrant Cloud.
 */

import { getStore } from '@edgeone/pages-blob';
import { createLogger } from '../_logger';
import { deleteDocumentPoints } from '../../agents/_qdrant';

const logger = createLogger('delete-document');

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function getBlobStore() {
  const storeName = process.env.BLOB_STORE_NAME || 'uploads';
  return getStore(storeName);
}

async function handleDelete(context: any): Promise<Response> {
  try {
    let body: any = {};
    if (context.request?.body) {
      body = context.request.body;
    } else if (typeof context.request?.json === 'function') {
      body = await context.request.json().catch(() => ({}));
    }

    const docId = String(body.docId || body.doc_id || '').trim();
    const storedName = String(body.storedName || '').trim();

    if (!docId && !storedName) {
      return jsonResponse({ error: 'Missing docId parameter' }, 400);
    }

    logger.log(`Deleting document docId="${docId}", storedName="${storedName}"`);
    let deletedCount = 0;

    // 1. Delete points from Qdrant Cloud
    if (docId) {
      const qdrantSuccess = await deleteDocumentPoints(docId);
      if (qdrantSuccess) {
        deletedCount += 1;
      }
    }

    // 2. Delete binary and metadata from EdgeOne Pages Blob Storage
    try {
      const blobStore = getBlobStore();
      if (storedName) {
        await blobStore.delete(`uploads/${storedName}`);
        deletedCount += 1;
      }
      if (docId) {
        await blobStore.delete(`uploads/${docId}.pdf`);
        await blobStore.delete(`uploads/${docId}.docx`);
        await blobStore.delete(`metadata/${docId}.json`);
        deletedCount += 1;
      }
    } catch (storeErr) {
      logger.warn('EdgeOne Blob Storage delete notice:', storeErr);
    }

    logger.log(`delete-document completed: docId="${docId}", deletedCount=${deletedCount}`);
    return jsonResponse({
      status: 'success',
      docId,
      deletedCount,
    });
  } catch (e: any) {
    logger.error('delete-document handler failed:', e);
    return jsonResponse({ error: `Failed to delete document: ${e.message || String(e)}` }, 500);
  }
}

export async function onRequestPost(context: any): Promise<Response> {
  return handleDelete(context);
}

export async function onRequestDelete(context: any): Promise<Response> {
  return handleDelete(context);
}
