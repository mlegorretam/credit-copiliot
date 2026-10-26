import { extractText, extractTextItems, getDocumentProxy } from "unpdf";

export type PdfExtractResult = {
  text: string;
  totalPages: number;
};

export type PositionedText = {
  str: string;
  x: number;
  y: number;
  width: number;
  fontSize?: number;
};

/**
 * Rebuild page text from positioned items so table rows stay on one line.
 * Default PDF text extraction concatenates cells with no column spacing, which
 * hides multi-quarter Adjusted EBITDA rows.
 */
export function layoutItemsToText(pages: PositionedText[][]): string {
  return pages
    .map((page) => layoutPage(page))
    .filter((page) => page.length > 0)
    .join("\n\n");
}

function layoutPage(items: PositionedText[]): string {
  const visible = dedupeItems(
    items.filter((item) => item.str.trim().length > 0),
  );
  if (visible.length === 0) return "";

  const sorted = [...visible].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: PositionedText[][] = [];

  for (const item of sorted) {
    const current = lines[lines.length - 1];
    const anchor = current?.[0];
    const fontSize = item.fontSize || anchor?.fontSize || 8;
    const tolerance = Math.max(2, fontSize * 0.45);
    if (!current || !anchor || Math.abs(item.y - anchor.y) > tolerance) {
      lines.push([item]);
    } else {
      current.push(item);
    }
  }

  return lines.map((line) => joinLine(line)).filter(Boolean).join("\n");
}

function dedupeItems(items: PositionedText[]): PositionedText[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${Math.round(item.x)}:${Math.round(item.y)}:${item.str}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function joinLine(items: PositionedText[]): string {
  const ordered = [...items].sort((a, b) => a.x - b.x || a.y - b.y);
  let text = "";
  let cursor = Number.NEGATIVE_INFINITY;

  for (const item of ordered) {
    const token = item.str.replace(/\s+/g, " ").trim();
    if (!token) continue;
    const gap = item.x - cursor;
    if (text && gap > 1) text += " ";
    text += token;
    const width =
      item.width > 0
        ? item.width
        : token.length * (item.fontSize ?? 8) * 0.45;
    cursor = item.x + width;
  }

  return text.replace(/[^\S\n]+/g, " ").trim();
}

export async function extractPdfText(
  data: Uint8Array | ArrayBuffer,
): Promise<PdfExtractResult> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const pdf = await getDocumentProxy(bytes);
  try {
    const positioned = await extractTextItems(pdf);
    const laidOut = layoutItemsToText(positioned.items).trim();
    if (laidOut.length > 0) {
      return { text: laidOut, totalPages: positioned.totalPages };
    }
    const plain = await extractText(pdf, { mergePages: true });
    return {
      text: plain.text.replace(/\r\n/g, "\n").trim(),
      totalPages: plain.totalPages,
    };
  } finally {
    await pdf.loadingTask.destroy();
  }
}
