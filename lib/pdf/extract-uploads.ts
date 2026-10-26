import { MIN_DOCUMENT_TEXT_CHARS } from "@/lib/constants";

export type ClientExtractedDocument = {
  fileName: string;
  text: string;
  totalPages: number;
};

export async function extractPdfUploads(files: File[]): Promise<{
  documents: ClientExtractedDocument[];
  extractionNotes: string[];
}> {
  const { extractPdfText } = await import("@/lib/pdf/extract-text");
  const documents: ClientExtractedDocument[] = [];
  const extractionNotes: string[] = [];

  for (const file of files) {
    try {
      const extracted = await extractPdfText(
        new Uint8Array(await file.arrayBuffer()),
      );
      if (extracted.text.length < MIN_DOCUMENT_TEXT_CHARS) {
        extractionNotes.push(
          `${file.name} contained too little extractable text and was excluded.`,
        );
        continue;
      }
      documents.push({
        fileName: file.name,
        text: extracted.text,
        totalPages: extracted.totalPages,
      });
    } catch {
      extractionNotes.push(
        `${file.name} could not be read as a text-based PDF and was excluded.`,
      );
    }
  }

  return { documents, extractionNotes };
}
