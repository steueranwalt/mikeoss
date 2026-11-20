import { getDocumentFile } from "./mikeApi";

/** Download bytes with consistent filename handling and object-URL cleanup. */
export function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    try {
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        try { link.click(); } finally { link.remove(); }
    } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
}

export async function downloadDocumentFile(
    documentId: string,
    versionId?: string | null,
    filename = "document",
    confirmToken?: string,
) {
    const file = await getDocumentFile(documentId, versionId, confirmToken);
    downloadBlob(file.blob, file.filename || filename);
}
