/**
 * Firecrawl Document Parsing Module for TypeScript.
 *
 * Uses official Firecrawl SDK v2 to parse PDF/DOCX files into structured Markdown in-memory.
 */

import { Firecrawl } from '@mendable/firecrawl-js';
import * as fs from 'node:fs';
import { createLogger } from './_logger';

const logger = createLogger('parser');

function getFirecrawlApiKey(): string {
  return process.env.FIRECRAWL_API_KEY || '';
}

/**
 * Parse a PDF or DOCX file (Buffer or filepath) to clean Markdown using Firecrawl.
 */
export async function parseDocumentToMarkdownViaFirecrawl(
  fileInput: Buffer | string,
  fileName: string,
): Promise<string> {
  const apiKey = getFirecrawlApiKey();

  if (!apiKey) {
    throw new Error('FIRECRAWL_API_KEY is required but not configured.');
  }

  logger.log(`Invoking Firecrawl SDK v2 for file: ${fileName}`);

  try {
    const app = new Firecrawl({ apiKey });
    
    let fileBuffer: Buffer;
    if (Buffer.isBuffer(fileInput)) {
      fileBuffer = fileInput;
    } else if (typeof fileInput === 'string' && fs.existsSync(fileInput)) {
      fileBuffer = fs.readFileSync(fileInput);
    } else {
      throw new Error(`Invalid file input for ${fileName}`);
    }

    const result = await app.parse(
      {
        data: fileBuffer,
        filename: fileName,
      },
      {
        formats: ['markdown'],
        onlyMainContent: true,
      },
    );

    const md = (result as any)?.markdown || (result as any)?.data?.markdown || '';
    if (md && typeof md === 'string' && md.trim().length > 0) {
      logger.log(`Firecrawl parsed ${md.length} characters of Markdown from ${fileName}`);
      return md.trim();
    }

    logger.warn('Firecrawl response contained no markdown content, checking raw text...');
    const rawText = (result as any)?.text || (result as any)?.data?.text || '';
    if (rawText) {
      return `# ${fileName}\n\n${rawText}`;
    }

    throw new Error('Firecrawl returned empty markdown content.');
  } catch (e: any) {
    logger.error(`Firecrawl SDK parse failed for ${fileName}:`, e);
    throw new Error(`Firecrawl parse failed: ${e.message || String(e)}`);
  }
}
