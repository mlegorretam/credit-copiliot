import { extractText, getDocumentProxy } from "unpdf";

export type PdfExtractResult = {
  text: string;
  totalPages: number;
};

export async function extractPdfText(buffer: Buffer): Promise<PdfExtractResult> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  return {
    text: text.replace(/\r\n/g, "\n").trim(),
    totalPages,
  };
}
