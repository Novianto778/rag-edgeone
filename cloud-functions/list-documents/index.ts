/**
 * POST & GET /list-documents — EdgeOne Makers Node Cloud Function.
 *
 * Lists all uploaded and indexed documents from Qdrant Cloud and EdgeOne Blob Storage (context.store).
 */

import { createLogger } from '../_logger';
import { listIndexedDocumentsFromQdrant } from '../../agents/_qdrant';

const logger = createLogger('list-documents');

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
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

async function getDocumentList(context?: any): Promise<CatalogItem[]> {
  const docMap = new Map<string, CatalogItem>();

  // 1. Fetch indexed documents from Qdrant Cloud (Primary persistent vector & metadata store)
  try {
    const qdrantDocs = await listIndexedDocumentsFromQdrant();
    for (const qd of qdrantDocs) {
      const isDocx = qd.docName.toLowerCase().endsWith('.docx');
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
  } catch (qErr) {
    logger.warn('Failed to retrieve documents from Qdrant:', qErr);
  }

  // 2. Supplement from EdgeOne Pages Blob Store (context.store) if available
  try {
    const store = context?.store || context?.agent?.store;
    if (store?.list) {
      const listRes = await store.list({ prefix: 'uploads/' });
      const items = Array.isArray(listRes) ? listRes : listRes?.blobs || listRes?.keys || [];
      for (const item of items) {
        const key = typeof item === 'string' ? item : item?.key || item?.name || '';
        if (!key) continue;

        const filename = key.replace(/^uploads\//, '');
        const ext = filename.toLowerCase().endsWith('.docx') ? '.docx' : '.pdf';
        const docId = filename.replace(/\.(pdf|docx|txt|md)$/i, '');
        const isDocx = ext === '.docx';

        if (docMap.has(docId)) {
          const entry = docMap.get(docId)!;
          if (item?.size) entry.fileSize = item.size;
        } else {
          docMap.set(docId, {
            docId,
            docName: filename,
            storedName: filename,
            fileSize: item?.size || 0,
            uploadedAt: item?.uploadedAt || item?.lastModified || new Date().toISOString(),
            type: isDocx ? 'DOCX' : 'PDF',
            status: 'ready',
          });
        }
      }
    }
  } catch (storeErr) {
    logger.warn('context.store list notice:', storeErr);
  }

  const documents = Array.from(docMap.values());
  documents.sort((a, b) => (b.uploadedAt || '').localeCompare(a.uploadedAt || ''));

  logger.log(`list-documents returning ${documents.length} document(s)`);
  return documents;
}

export async function onRequestPost(context: any): Promise<Response> {
  try {
    const documents = await getDocumentList(context);
    return jsonResponse({ status: 'success', documents });
  } catch (e: any) {
    logger.error('list-documents handler failed:', e);
    return jsonResponse({ error: `Failed to list documents: ${e.message || String(e)}` }, 500);
  }
}

export async function onRequestGet(context: any): Promise<Response> {
  try {
    const documents = await getDocumentList(context);
    return jsonResponse({ status: 'success', documents });
  } catch (e: any) {
    logger.error('list-documents handler failed:', e);
    return jsonResponse({ error: `Failed to list documents: ${e.message || String(e)}` }, 500);
  }
}
