/**
 * Gate B4 audit finding N16: dispatches to whichever stamper actually has a
 * banner-stamping capability for a given file type. Only .docx
 * (docxAiDraftWatermark.ts) and .pdf (pdfAiDraftWatermark.ts) do — every
 * other confirmed-draft format (xlsx, pptx, csv, ...) has no way to inject a
 * visible banner into the bytes themselves, so those callers fall back to
 * withAiDraftFilenamePrefix on the filename instead (see documentVersions.ts).
 *
 * Both stampers are fail-closed: they throw rather than return the input
 * unchanged when the file cannot be parsed, so every caller's existing
 * try/catch → 409 "stamping_failed" handling applies unchanged here too.
 */
import { stampAiDraftWatermark } from "./docxAiDraftWatermark";
import { stampPdfAiDraftWatermark } from "./pdfAiDraftWatermark";

export const STAMPABLE_AI_DRAFT_FILE_TYPES = new Set(["docx", "pdf"]);

export function isStampableAiDraftFileType(fileType: string | null | undefined): boolean {
    return STAMPABLE_AI_DRAFT_FILE_TYPES.has(fileType ?? "");
}

export async function stampAiDraftBytes(
    fileType: string | null | undefined,
    bytes: Buffer,
): Promise<Buffer> {
    if (fileType === "docx") return stampAiDraftWatermark(bytes);
    if (fileType === "pdf") return stampPdfAiDraftWatermark(bytes);
    throw new Error(`No AI-draft stamping capability for file type: ${fileType}`);
}
