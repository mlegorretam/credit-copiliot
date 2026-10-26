export const MAX_PDF_BYTES = 10 * 1024 * 1024;

/** Maximum number of PDFs accepted in one analysis. */
export const MAX_PDF_FILES = 8;

/** Combined upload limit across all PDFs in one request. */
export const MAX_TOTAL_PDF_BYTES = 40 * 1024 * 1024;

/**
 * Stay under Vercel’s 4.5 MB function body limit, including multipart overhead.
 * Larger PDFs are extracted in the browser and sent as JSON text.
 */
export const MAX_HOSTED_UPLOAD_BYTES = 4 * 1024 * 1024;

/** Character budget for a single filing sent to the model. */
export const MAX_FILING_CONTEXT_CHARS = 100_000;

/** Character budget when several filings are combined. */
export const MAX_MULTI_FILING_CONTEXT_CHARS = 200_000;

export const MIN_EXTRACTED_TEXT_CHARS = 200;

/** Documents below this length are treated as unscanned / empty when others succeed. */
export const MIN_DOCUMENT_TEXT_CHARS = 50;

export const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";
