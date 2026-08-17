/**
 * Firecrawl Document Parsing Module for TypeScript.
 *
 * Uses official Firecrawl SDK v2 to parse PDF/DOCX files into structured Markdown.
 */

import { Firecrawl } from '@mendable/firecrawl-js';
import * as fs from 'node:fs';
import { createLogger } from './_logger';

const logger = createLogger('parser');

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY || '';

/**
 * Parse a PDF or DOCX file to clean Markdown using Firecrawl.
 */
export async function parseDocumentToMarkdownViaFirecrawl(
  filePath: string,
  fileName: string,
): Promise<string> {
  const apiKey = FIRECRAWL_API_KEY || process.env.FIRECRAWL_API_KEY || '';

  if (!apiKey) {
    throw new Error('FIRECRAWL_API_KEY is required but not configured.');
  }

  logger.log(`Invoking Firecrawl SDK v2 for file: ${fileName}`);

  try {
    const app = new Firecrawl({ apiKey });
    const fileBuffer = fs.readFileSync(filePath);

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
