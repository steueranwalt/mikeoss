/**
 * Gate B4 audit finding N16: stamps a visible "AI draft, not approved" banner
 * onto every page of a confirmed PDF export/display, the same way
 * docxAiDraftWatermark.ts does for .docx — a bold, red banner across the top
 * of each page, so the warning travels with the file wherever it ends up,
 * not just in this one response.
 *
 * Fail-closed (Gate B4 audit finding N6/N16): throws rather than returning
 * the input bytes unchanged when the PDF cannot be parsed. Every caller
 * treats a thrown error as fail-closed (refuse the download) — silently
 * handing back the original, unstamped bytes here would be the exact
 * fail-open behavior that refusal exists to prevent.
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export const AI_DRAFT_WATERMARK_TEXT = "KI-ENTWURF \u2013 NICHT FREIGEGEBEN";

const BANNER_HEIGHT = 28;
const BANNER_COLOR = rgb(0.75, 0, 0);
const TEXT_COLOR = rgb(1, 1, 1);
const FONT_SIZE = 14;

export async function stampPdfAiDraftWatermark(bytes: Buffer): Promise<Buffer> {
    let pdf: PDFDocument;
    try {
        pdf = await PDFDocument.load(bytes);
    } catch (error) {
        throw new Error(
            `Not a well-formed PDF: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    const font = await pdf.embedFont(StandardFonts.HelveticaBold);
    const pages = pdf.getPages();
    if (pages.length === 0) throw new Error("PDF has no pages to stamp");
    const textWidth = font.widthOfTextAtSize(AI_DRAFT_WATERMARK_TEXT, FONT_SIZE);
    for (const page of pages) {
        const { width, height } = page.getSize();
        page.drawRectangle({
            x: 0,
            y: height - BANNER_HEIGHT,
            width,
            height: BANNER_HEIGHT,
            color: BANNER_COLOR,
        });
        page.drawText(AI_DRAFT_WATERMARK_TEXT, {
            x: Math.max((width - textWidth) / 2, 4),
            y: height - BANNER_HEIGHT + (BANNER_HEIGHT - FONT_SIZE) / 2,
            size: FONT_SIZE,
            font,
            color: TEXT_COLOR,
        });
    }
    const saved = await pdf.save();
    return Buffer.from(saved);
}
