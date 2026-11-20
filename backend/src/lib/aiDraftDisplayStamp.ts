/**
 * Gate B4 audit finding N17: /display of an unapproved AI draft / unresolved
 * edit is still a display (no confirmation), but the bytes on screen must
 * carry the banner. The PDF stamper is fail-closed. Formats that are not
 * already PDF (xlsx, csv, html, images) are converted to a PDF first, or
 * the display is refused rather than showing the unstamped original.
 */
import { PDFDocument, StandardFonts } from "pdf-lib";
import { officeBytesToPdf } from "./convert";
import { isSpreadsheetDocumentType, isTextDocumentType } from "./documentTypes";
import { stampPdfAiDraftWatermark } from "./pdfAiDraftWatermark";

const IMAGE_TYPES = new Set(["png", "jpg", "jpeg"]);
const OFFICE_TYPES = new Set([
  "xlsx",
  "xlsm",
  "xls",
  "docx",
  "doc",
  "pptx",
  "ppt",
]);

function normalizedType(fileType: string | null | undefined): string {
  return (fileType ?? "").trim().toLowerCase();
}

async function wrapImageAsPdf(bytes: Buffer, fileType: string): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const image =
    fileType === "png" ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
  const page = pdf.addPage([image.width, image.height]);
  page.drawImage(image, {
    x: 0,
    y: 0,
    width: image.width,
    height: image.height,
  });
  return Buffer.from(await pdf.save());
}

async function wrapTextAsPdf(bytes: Buffer): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Courier);
  const page = pdf.addPage([612, 792]);
  const text = bytes.toString("utf8").replace(/<[^>]+>/g, " ");
  const lines = text.split(/\r?\n/);
  let y = 760;
  for (const line of lines) {
    page.drawText(line.slice(0, 110), { x: 36, y, size: 9, font });
    y -= 12;
    if (y < 36) break;
  }
  return Buffer.from(await pdf.save());
}

/**
 * Turn whatever /display loaded into a PDF that can carry the AI-draft
 * banner. Throws when the format cannot be converted — callers refuse the
 * preview rather than showing the original unstamped bytes.
 */
export async function displayBytesAsPdf(
  bytes: Buffer,
  fileType: string | null | undefined,
  contentType: string,
): Promise<Buffer> {
  if (contentType.includes("application/pdf")) return bytes;
  const type = normalizedType(fileType);
  if (IMAGE_TYPES.has(type)) return wrapImageAsPdf(bytes, type);
  if (isTextDocumentType(type)) return wrapTextAsPdf(bytes);
  if (OFFICE_TYPES.has(type) || isSpreadsheetDocumentType(type)) {
    return officeBytesToPdf(bytes);
  }
  throw new Error(`No AI-draft display conversion for file type: ${type || contentType}`);
}

export async function stampAiDraftDisplayBytes(
  bytes: Buffer,
  fileType: string | null | undefined,
  contentType: string,
): Promise<Buffer> {
  const pdf = await displayBytesAsPdf(bytes, fileType, contentType);
  return stampPdfAiDraftWatermark(pdf);
}
