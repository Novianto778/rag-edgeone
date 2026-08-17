/**
 * POST & GET /list-documents — EdgeOne Makers Node Cloud Function.
 *
 * Lists all uploaded and indexed documents from Qdrant Cloud and local uploads storage.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../_logger';
import { listIndexedDocumentsFromQdrant } from '../../agents/_qdrant';

const logger = createLogger('list-documents');

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads');

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

  // 1. Fetch indexed documents from Qdrant Cloud
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

  // 2. Supplement / fallback from local disk uploads directory
  if (fs.existsSync(UPLOADS_DIR)) {
    try {
      const files = fs.readdirSync(UPLOADS_DIR);
      for (const file of files) {
        if (file.startsWith('.')) continue;
        const fullPath = path.join(UPLOADS_DIR, file);
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) continue;

        const ext = path.extname(file).toLowerCase();
        const docId = path.basename(file, ext);
        const isDocx = ext === '.docx';

        if (docMap.has(docId)) {
          const item = docMap.get(docId)!;
          item.fileSize = stat.size;
          item.storedName = file;
          if (!item.uploadedAt) {
            item.uploadedAt = stat.mtime.toISOString();
          }
        } else {
          docMap.set(docId, {
            docId,
            docName: file,
            storedName: file,
            fileSize: stat.size,
            uploadedAt: stat.mtime.toISOString(),
            type: isDocx ? 'DOCX' : 'PDF',
            status: 'ready',
          });
        }
      }
    } catch (diskErr) {
      logger.warn('Failed to read local uploads directory:', diskErr);
    }
  }

  const documents = Array.from(docMap.values());
  documents.sort((a, b) => (b.uploadedAt || '').localeCompare(a.uploadedAt || ''));

  logger.log(`list-documents returning ${documents.length} document(s)`);
  return documents;
}

export async function onRequestPost(_context: any): Promise<Response> {
  try {
    const documents = await getDocumentList();
    return jsonResponse({ status: 'success', documents });
  } catch (e: any) {
    logger.error('list-documents handler failed:', e);
    return jsonResponse({ error: `Failed to list documents: ${e.message || String(e)}` }, 500);
  }
}

export async function onRequestGet(_context: any): Promise<Response> {
  try {
    const documents = await getDocumentList();
    return jsonResponse({ status: 'success', documents });
  } catch (e: any) {
    logger.error('list-documents handler failed:', e);
    return jsonResponse({ error: `Failed to list documents: ${e.message || String(e)}` }, 500);
  }
}
