import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { AI_DRAFT_WATERMARK_TEXT, stampAiDraftWatermark } from "../docxAiDraftWatermark";

const W_NS =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

async function makeDocx(bodyXml: string): Promise<Buffer> {
    const zip = new JSZip();
    zip.file(
        "word/document.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
            `<w:document ${W_NS}><w:body>${bodyXml}</w:body></w:document>`,
    );
    return zip.generateAsync({ type: "nodebuffer" });
}

function para(text: string): string {
    return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

async function readDocumentXml(bytes: Buffer): Promise<string> {
    const zip = await JSZip.loadAsync(bytes);
    return zip.file("word/document.xml")!.async("string");
}

describe("stampAiDraftWatermark", () => {
    it("prepends a visible banner paragraph carrying the warning text", async () => {
        const original = await makeDocx(para("Original content."));
        const stamped = await stampAiDraftWatermark(original);
        const xml = await readDocumentXml(stamped);
        expect(xml).toContain(AI_DRAFT_WATERMARK_TEXT);
        // Bold and colored, so it is visually unmistakable in Word.
        expect(xml).toMatch(/<w:b\s*\/?>/);
        expect(xml).toMatch(/<w:color w:val="C00000"\s*\/?>/);
        // The original content survives, after the banner.
        const bannerIndex = xml.indexOf(AI_DRAFT_WATERMARK_TEXT);
        const originalIndex = xml.indexOf("Original content.");
        expect(bannerIndex).toBeGreaterThanOrEqual(0);
        expect(originalIndex).toBeGreaterThan(bannerIndex);
    });

    it("does not change the byte-for-byte document for a non-.docx input", async () => {
        const notADocx = Buffer.from("not a zip at all");
        await expect(stampAiDraftWatermark(notADocx)).rejects.toThrow();
    });

    // Gate B4 audit finding N16 (rest of N6): a broken/unstampable .docx must
    // refuse rather than silently hand back the unstamped original — every
    // caller treats a thrown error as fail-closed (refuse the download).
    it("throws instead of returning unstamped bytes for a .docx with no word/document.xml", async () => {
        const zip = new JSZip();
        zip.file("README.txt", "not a word document");
        const bytes = await zip.generateAsync({ type: "nodebuffer" });
        await expect(stampAiDraftWatermark(bytes)).rejects.toThrow(
            /word\/document\.xml is missing/,
        );
    });

    it("throws instead of returning unstamped bytes for a .docx whose document.xml has no <w:body>", async () => {
        const zip = new JSZip();
        zip.file(
            "word/document.xml",
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS}></w:document>`,
        );
        const bytes = await zip.generateAsync({ type: "nodebuffer" });
        await expect(stampAiDraftWatermark(bytes)).rejects.toThrow(
            /no <w:body>/,
        );
    });
});
