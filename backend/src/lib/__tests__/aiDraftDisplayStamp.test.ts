import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  stampAiDraftDisplayBytes,
  stripHtmlForDisplay,
} from "../aiDraftDisplayStamp";

function pdfInflatedText(bytes: Buffer): string {
  const raw = bytes.toString("latin1");
  const chunks: string[] = [];
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try {
      chunks.push(inflateSync(Buffer.from(match[1], "latin1")).toString("latin1"));
    } catch {
      chunks.push(match[1]);
    }
  }
  return chunks
    .join("\n")
    .replace(/<([0-9A-Fa-f]+)>/g, (_, hex: string) =>
      Buffer.from(hex, "hex").toString("latin1"),
    );
}

describe("stampAiDraftDisplayBytes text/html wrap (N34)", () => {
  it("strips script and style from HTML before wrapping", async () => {
    expect(
      stripHtmlForDisplay(
        "<html><head><style>body{color:red}</style><script>alert(1)</script></head><body><p>Visible clause</p></body></html>",
      ),
    ).toMatch(/Visible clause/);
    expect(
      stripHtmlForDisplay(
        "<html><head><style>body{color:red}</style><script>alert(1)</script></head><body><p>Visible clause</p></body></html>",
      ),
    ).not.toMatch(/alert\(1\)|color:red/);

    const html = Buffer.from(
      "<html><head><style>body{color:red}</style><script>alert(1)</script></head><body><p>Visible clause</p></body></html>",
    );
    const stamped = await stampAiDraftDisplayBytes(html, "html", "text/html");
    const pdf = await PDFDocument.load(stamped);
    expect(pdf.getPageCount()).toBe(1);
    const text = pdfInflatedText(stamped);
    expect(text).toContain("Visible clause");
    expect(text).not.toContain("alert(1)");
    expect(text).not.toContain("color:red");
  });

  it("notes that further pages are not shown when the text overflows", async () => {
    const lines = Array.from({ length: 80 }, (_, i) => `Line ${i + 1} of the memo`).join(
      "\n",
    );
    const stamped = await stampAiDraftDisplayBytes(
      Buffer.from(lines),
      "txt",
      "text/plain",
    );
    expect(pdfInflatedText(stamped)).toContain("weitere Seiten nicht dargestellt");
  });
});
