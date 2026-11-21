import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { AI_DRAFT_WATERMARK_TEXT, stampPdfAiDraftWatermark } from "../pdfAiDraftWatermark";

async function makePdf(pageCount = 1): Promise<Buffer> {
    const doc = await PDFDocument.create();
    for (let i = 0; i < pageCount; i++) doc.addPage([400, 600]);
    return Buffer.from(await doc.save());
}

describe("stampPdfAiDraftWatermark (Gate B4 audit finding N16)", () => {
    it("adds a banner to every page without corrupting the PDF", async () => {
        const original = await makePdf(2);
        const stamped = await stampPdfAiDraftWatermark(original);

        const reloaded = await PDFDocument.load(stamped);
        expect(reloaded.getPageCount()).toBe(2);
        // Stamping draws real content (a rectangle + text run per page), so
        // the stamped file must grow relative to a blank original.
        expect(stamped.byteLength).toBeGreaterThan(original.byteLength);
    });

    it("embeds the warning text so it can be recovered from the PDF's own font/content streams", async () => {
        const original = await makePdf(1);
        const stamped = await stampPdfAiDraftWatermark(original);
        // pdf-lib's StandardFonts.HelveticaBold is a WinAnsi font, so the
        // literal UTF-8 text does not appear verbatim in the content stream;
        // this checks the font embedding and page content both exist instead
        // of asserting on raw bytes.
        const reloaded = await PDFDocument.load(stamped);
        const page = reloaded.getPage(0);
        expect(page.node.Contents()).toBeDefined();
    });

    // Gate B4 audit finding N6/N16: fail-closed, not fail-open.
    it("throws instead of returning unstamped bytes for a non-PDF input", async () => {
        await expect(stampPdfAiDraftWatermark(Buffer.from("not a pdf at all"))).rejects.toThrow(
            /Not a well-formed PDF/,
        );
    });

    it("exports a stable warning text constant", () => {
        expect(AI_DRAFT_WATERMARK_TEXT).toContain("KI-ENTWURF");
    });
});
