import {
  MAX_PDF_BYTES,
  MAX_PDF_FILES,
  MAX_TOTAL_PDF_BYTES,
} from "@/lib/constants";

export type UploadLike = {
  name: string;
  size: number;
  type?: string;
  lastModified?: number;
};

export type UploadValidation =
  | { ok: true }
  | { ok: false; error: string; status: number };

export function isPdfUpload(file: { name: string; type?: string }): boolean {
  const type = file.type ?? "";
  return (
    type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
  );
}

function maxSizeLabel(): string {
  return `${MAX_PDF_BYTES / (1024 * 1024)} MB`;
}

function totalSizeLabel(): string {
  return `${MAX_TOTAL_PDF_BYTES / (1024 * 1024)} MB`;
}

export function validatePdfUploads(files: UploadLike[]): UploadValidation {
  const named = files.filter((file) => file.name.trim().length > 0);
  if (named.length === 0) {
    return { ok: false, error: "A PDF filing is required.", status: 400 };
  }
  if (named.length > MAX_PDF_FILES) {
    return {
      ok: false,
      error: `Upload up to ${MAX_PDF_FILES} PDFs at a time.`,
      status: 400,
    };
  }

  let total = 0;
  for (const file of named) {
    if (!isPdfUpload(file)) {
      return {
        ok: false,
        error: `"${file.name}" is not a PDF. Only PDF files are supported.`,
        status: 400,
      };
    }
    if (file.size === 0) {
      return {
        ok: false,
        error: `"${file.name}" is empty.`,
        status: 400,
      };
    }
    if (file.size > MAX_PDF_BYTES) {
      return {
        ok: false,
        error: `"${file.name}" must be ${maxSizeLabel()} or smaller.`,
        status: 413,
      };
    }
    total += file.size;
  }

  if (total > MAX_TOTAL_PDF_BYTES) {
    return {
      ok: false,
      error: `Combined PDFs must be ${totalSizeLabel()} or smaller.`,
      status: 413,
    };
  }

  return { ok: true };
}

function sameFile(a: UploadLike, b: UploadLike): boolean {
  return (
    a.name === b.name &&
    a.size === b.size &&
    (a.lastModified ?? 0) === (b.lastModified ?? 0)
  );
}

/** Append newly chosen PDFs, keeping files that already passed and skipping exact duplicates. */
export function addPdfSelections<T extends UploadLike>(
  current: T[],
  incoming: T[],
): { files: T[]; error: string | null } {
  const next = [...current];
  const errors: string[] = [];

  for (const file of incoming) {
    if (!file.name.trim()) continue;
    if (!isPdfUpload(file)) {
      errors.push(`"${file.name}" is not a PDF.`);
      continue;
    }
    if (file.size === 0) {
      errors.push(`"${file.name}" is empty.`);
      continue;
    }
    if (file.size > MAX_PDF_BYTES) {
      errors.push(`"${file.name}" must be ${maxSizeLabel()} or smaller.`);
      continue;
    }
    if (next.some((existing) => sameFile(existing, file))) {
      continue;
    }
    if (next.length >= MAX_PDF_FILES) {
      errors.push(`Upload up to ${MAX_PDF_FILES} PDFs at a time.`);
      break;
    }
    const total = next.reduce((sum, item) => sum + item.size, 0) + file.size;
    if (total > MAX_TOTAL_PDF_BYTES) {
      errors.push(
        `"${file.name}" was not added because combined PDFs must be ${totalSizeLabel()} or smaller.`,
      );
      continue;
    }
    next.push(file);
  }

  return {
    files: next,
    error: errors.length > 0 ? errors.join(" ") : null,
  };
}

/** Give duplicate filenames distinct labels so citations can tell them apart. */
export function disambiguateFileNames(names: string[]): string[] {
  const totals = new Map<string, number>();
  for (const name of names) {
    totals.set(name, (totals.get(name) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return names.map((name) => {
    if ((totals.get(name) ?? 0) < 2) return name;
    const index = (seen.get(name) ?? 0) + 1;
    seen.set(name, index);
    return `${name} (${index})`;
  });
}
