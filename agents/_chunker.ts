/**
 * Section-Aware Parent-Child Chunking Module for RAG Pipeline.
 *
 * Splits Markdown text by headings (#, ##, ###) into Parent Sections, preserving section hierarchy breadcrumbs,
 * and creates 200-token Child Chunks with 20% overlap linked to their parent sections.
 */

import { createHash, randomUUID } from 'node:crypto';

export interface ParentSection {
  parent_id: string;
  doc_id: string;
  doc_name: string;
  section_path: string;
  parent_text: string;
  heading_title: string;
}

export interface ChildChunk {
  child_id: string;
  child_index: number;
  parent_id: string;
  doc_id: string;
  doc_name: string;
  section_path: string;
  parent_text: string;
  child_text: string;
  token_count: number;
}

/**
 * Generate a deterministic UUID-like string from input text or unique seed.
 */
function deterministicId(seed: string): string {
  const hash = createHash('sha256').update(seed).digest('hex');
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    '4' + hash.substring(13, 16),
    'a' + hash.substring(17, 20),
    hash.substring(20, 32),
  ].join('-');
}

/**
 * Rough token estimation (1 token ≈ 4 chars or whitespace-separated words).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const words = text.trim().split(/\s+/).length;
  const chars = Math.floor(text.length / 4);
  return Math.max(words, chars);
}

/**
 * Split Markdown text by headings (#, ##, ###) into Parent Sections with breadcrumb hierarchy.
 */
export function splitMarkdownIntoParentSections(
  markdownText: string,
  docId: string,
  docName: string,
): ParentSection[] {
  const text = markdownText.trim();
  if (!text) return [];

  const headingRegex = /^(#{1,4})\s+(.+)$/gm;
  const matches: { index: number; level: number; title: string }[] = [];

  let match: RegExpExecArray | null;
  while ((match = headingRegex.exec(text)) !== null) {
    matches.push({
      index: match.index,
      level: match[1].length,
      title: match[2].trim(),
    });
  }

  if (matches.length === 0) {
    // Fallback if no headings found: treating entire document as single parent section
    const parentId = deterministicId(`${docId}_parent_0`);
    return [
      {
        parent_id: parentId,
        doc_id: docId,
        doc_name: docName,
        section_path: docName,
        parent_text: text,
        heading_title: docName,
      },
    ];
  }

  const parentSections: ParentSection[] = [];
  const headingStack: { level: number; title: string }[] = [];

  for (let idx = 0; idx < matches.length; idx++) {
    const cur = matches[idx];
    const level = cur.level;
    const title = cur.title;

    // Manage heading hierarchy stack for breadcrumbs
    while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
      headingStack.pop();
    }
    headingStack.push({ level, title });

    const sectionPath = headingStack.map((h) => h.title).join(' > ');

    const startPos = cur.index;
    const endPos = idx + 1 < matches.length ? matches[idx + 1].index : text.length;
    const sectionContent = text.substring(startPos, endPos).trim();

    const parentId = deterministicId(`${docId}_parent_${idx}`);

    if (sectionContent) {
      parentSections.push({
        parent_id: parentId,
        doc_id: docId,
        doc_name: docName,
        section_path: sectionPath,
        parent_text: sectionContent,
        heading_title: title,
      });
    }
  }

  return parentSections;
}

/**
 * Divide Parent Sections into ~200-token Child Chunks with 20% overlap.
 */
export function createChildChunksFromParents(
  parentSections: ParentSection[],
  targetChildTokens = 200,
  overlapRatio = 0.2,
): ChildChunk[] {
  const allChildChunks: ChildChunk[] = [];
  let globalChildIdx = 0;

  const chunkSizeChars = targetChildTokens * 4;
  const overlapChars = Math.floor(chunkSizeChars * overlapRatio);

  for (const parent of parentSections) {
    const text = parent.parent_text;
    const textLen = text.length;

    if (textLen <= chunkSizeChars) {
      const childId = deterministicId(`${parent.doc_id}_child_${globalChildIdx}`);
      allChildChunks.push({
        child_id: childId,
        child_index: globalChildIdx,
        parent_id: parent.parent_id,
        doc_id: parent.doc_id,
        doc_name: parent.doc_name,
        section_path: parent.section_path,
        parent_text: parent.parent_text,
        child_text: text,
        token_count: estimateTokens(text),
      });
      globalChildIdx += 1;
    } else {
      const step = chunkSizeChars - overlapChars;
      let start = 0;
      while (start < textLen) {
        const end = Math.min(start + chunkSizeChars, textLen);
        const childSlice = text.substring(start, end).trim();

        if (childSlice) {
          const childId = deterministicId(`${parent.doc_id}_child_${globalChildIdx}`);
          allChildChunks.push({
            child_id: childId,
            child_index: globalChildIdx,
            parent_id: parent.parent_id,
            doc_id: parent.doc_id,
            doc_name: parent.doc_name,
            section_path: parent.section_path,
            parent_text: parent.parent_text,
            child_text: childSlice,
            token_count: estimateTokens(childSlice),
          });
          globalChildIdx += 1;
        }

        start += step;
      }
    }
  }

  return allChildChunks;
}
