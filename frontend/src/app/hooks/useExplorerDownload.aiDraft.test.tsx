import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { downloadDocumentsZip, getDocumentUrl, MikeApiError } from "@/app/lib/mikeApi";
import type { Document, Folder } from "@/app/components/shared/types";
import { useExplorerDownload } from "./useExplorerDownload";

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    getDocumentUrl: vi.fn(),
    downloadDocumentsZip: vi.fn(),
}));

const documentFile = { id: "doc-1", filename: "Old-name.docx" } as Document;
let downloads: Array<{ href: string; filename: string }>;

beforeEach(() => {
    vi.clearAllMocks();
    downloads = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
        this: HTMLAnchorElement,
    ) {
        downloads.push({ href: this.href, filename: this.download });
    });
});
afterEach(() => {
    vi.restoreAllMocks();
});

it("opens the export dialog on unresolved_ai_edits and retries with confirm_token", async () => {
    vi.mocked(getDocumentUrl)
        .mockRejectedValueOnce(
            new MikeApiError({
                message: "This document has AI-proposed changes.",
                status: 409,
                code: "unresolved_ai_edits",
                details: {
                    confirm_token: "token-1",
                    version_id: "version-1",
                    pending_edit_ids: ["edit-1"],
                    ai_draft: true,
                },
            }),
        )
        .mockResolvedValueOnce({
            url: "https://files.example/stamped",
            filename: "Draft.docx",
            version_id: "version-1",
        });
    function Harness() {
        const value = useExplorerDownload();
        return (
            <>
                <button
                    type="button"
                    onClick={() => void value.downloadDocument(documentFile)}
                >
                    Download
                </button>
                {value.confirmation}
            </>
        );
    }
    render(<Harness />);
    await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Download" }));
    });
    expect(await screen.findByRole("dialog")).toHaveTextContent("version-1");
    await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Export anyway" }));
    });
    expect(getDocumentUrl).toHaveBeenLastCalledWith(
        "doc-1",
        undefined,
        "token-1",
    );
    expect(downloads).toEqual([
        { href: "https://files.example/stamped", filename: "Draft.docx" },
    ]);
});

it("opens the export dialog for a folder zip 409 and retries with confirm_tokens (N26)", async () => {
    vi.mocked(downloadDocumentsZip)
        .mockRejectedValueOnce(
            new MikeApiError({
                message: "This selection has AI-proposed changes.",
                status: 409,
                code: "unresolved_ai_edits",
                details: {
                    documents: [
                        {
                            document_id: "doc-1",
                            filename: "one.docx",
                            confirm_token: "token-1",
                        },
                    ],
                },
            }),
        )
        .mockResolvedValueOnce(new Blob(["zip"]));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:zip");
    function Harness() {
        const value = useExplorerDownload();
        return (
            <>
                <button
                    type="button"
                    onClick={() =>
                        void value.downloadFolder({
                            id: "folder-1",
                            name: "Folder",
                        } as Folder)
                    }
                >
                    Zip
                </button>
                {value.confirmation}
            </>
        );
    }
    render(<Harness />);
    await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Zip" }));
    });
    expect(await screen.findByRole("dialog")).toHaveTextContent("one.docx");
    await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Export anyway" }));
    });
    expect(downloadDocumentsZip).toHaveBeenLastCalledWith([], ["folder-1"], {
        "doc-1": "token-1",
    });
});
