/**
 * POST & DELETE /delete-document — EdgeOne Makers Node Cloud Function.
 *
 * Deletes points from Qdrant Cloud and removes blobs from EdgeOne Blob Storage (context.store).
 */

import { createLogger } from '../_logger';
import { deleteDocumentPoints } from '../../agents/_qdrant';

const logger = createLogger('delete-document');

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
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

    // 2. Delete from EdgeOne Pages Blob Store (context.store) if available
    try {
      const store = context?.store || context?.agent?.store;
      if (store?.delete) {
        if (storedName) {
          await store.delete(`uploads/${storedName}`);
          deletedCount += 1;
        }
        if (docId) {
          await store.delete(`uploads/${docId}.pdf`);
          await store.delete(`uploads/${docId}.docx`);
        }
      }
    } catch (storeErr) {
      logger.warn('context.store delete notice:', storeErr);
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
