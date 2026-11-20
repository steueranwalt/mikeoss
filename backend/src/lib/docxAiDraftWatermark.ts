/**
 * Gate B4 audit finding L3: stamps a visible "AI draft, not approved" banner
 * into a .docx's body as the very first paragraph when it is exported while
 * carrying unresolved AI-proposed changes (document_edits.status='pending').
 *
 * Deliberately a bold, colored first-page banner paragraph rather than a true
 * Word page header (header1.xml) or a diagonal WordArt watermark: both need
 * new relationship parts, content-type registrations and section-properties
 * wiring that a plain .docx may not already have, while a prepended body
 * paragraph is always safe to insert and is the first thing the reader sees
 * when the document opens — effectively a "Kopfzeile" for this purpose. Built
 * with the same JSZip + fast-xml-parser (preserveOrder) machinery as
 * docxTrackedChanges.ts, so it round-trips the rest of the document exactly.
 */
import JSZip from "jszip";
import { XMLParser, XMLBuilder } from "fast-xml-parser";

type XNode = Record<string, unknown>;

const ATTR_KEY = ":@";
const TEXT_KEY = "#text";

export const AI_DRAFT_WATERMARK_TEXT = "KI-ENTWURF \u2013 NICHT FREIGEGEBEN";

function getZipEntry(zip: JSZip, pathSlash: string) {
    const direct = zip.file(pathSlash);
    if (direct) return direct;
    return zip.file(pathSlash.replace(/\//g, "\\"));
}

function setZipEntry(zip: JSZip, pathSlash: string, content: string): void {
    const backslash = pathSlash.replace(/\//g, "\\");
    if (!zip.file(pathSlash) && zip.file(backslash)) {
        zip.file(backslash, content);
        return;
    }
    zip.file(pathSlash, content);
}

function elName(n: unknown): string | null {
    if (!n || typeof n !== "object") return null;
    for (const k of Object.keys(n as XNode)) {
        if (k === ATTR_KEY || k === TEXT_KEY) continue;
        return k;
    }
    return null;
}

function elChildren(n: unknown): XNode[] {
    const name = elName(n);
    if (!name) return [];
    const v = (n as XNode)[name];
    return Array.isArray(v) ? (v as XNode[]) : [];
}

function createParser() {
    return new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        preserveOrder: true,
        trimValues: false,
        parseTagValue: false,
        parseAttributeValue: false,
        processEntities: true,
    });
}

function createBuilder() {
    return new XMLBuilder({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        preserveOrder: true,
        suppressEmptyNode: false,
        processEntities: true,
    });
}

function findBody(doc: XNode[]): XNode[] | null {
    for (const top of doc) {
        if (elName(top) === "w:document") {
            for (const c of elChildren(top)) {
                if (elName(c) === "w:body") return elChildren(c);
            }
        }
    }
    return null;
}

/** The banner paragraph: bold, red, centered, in its own run and paragraph. */
function bannerParagraph(text: string): XNode {
    return {
        "w:p": [
            {
                "w:pPr": [{ "w:jc": [], [ATTR_KEY]: { "@_w:val": "center" } }],
            },
            {
                "w:r": [
                    {
                        "w:rPr": [
                            { "w:b": [] },
                            { "w:color": [], [ATTR_KEY]: { "@_w:val": "C00000" } },
                        ],
                    },
                    {
                        "w:t": [{ [TEXT_KEY]: text }],
                        [ATTR_KEY]: { "@_xml:space": "preserve" },
                    },
                ],
            },
        ],
    };
}

/**
 * Returns new .docx bytes with the banner paragraph prepended to the body.
 * Idempotent in practice but not guarded against double-stamping — callers
 * are expected to stamp a fresh copy of the stored bytes per export, never
 * the stored bytes themselves (see documents.download.ts).
 *
 * Gate B4 audit finding N16 (rest of N6): throws rather than returning the
 * input bytes unchanged when the .docx cannot be parsed or has no body to
 * stamp. Every caller treats a thrown error as fail-closed (refuse the
 * download, Gate B4 audit finding N6) — silently handing back the original,
 * unstamped bytes here would be the exact fail-open behavior that refusal
 * exists to prevent.
 */
export async function stampAiDraftWatermark(bytes: Buffer): Promise<Buffer> {
    const zip = await JSZip.loadAsync(bytes);
    const docXmlFile = getZipEntry(zip, "word/document.xml");
    if (!docXmlFile) throw new Error("Not a well-formed .docx: word/document.xml is missing");
    const xml = await docXmlFile.async("string");
    const parsed = createParser().parse(xml) as XNode[];
    const body = findBody(parsed);
    if (!body) throw new Error("Not a well-formed .docx: word/document.xml has no <w:body>");
    body.unshift(bannerParagraph(AI_DRAFT_WATERMARK_TEXT));
    const rebuilt = createBuilder().build(parsed) as string;
    setZipEntry(zip, "word/document.xml", rebuilt);
    return zip.generateAsync({ type: "nodebuffer" });
}
