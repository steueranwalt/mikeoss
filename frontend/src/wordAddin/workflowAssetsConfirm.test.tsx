import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MikeApiError } from "../../../word-addin/src/taskpane/api/client";

const {
    listWorkflowAssets,
    getWorkflowAssetUrl,
    deleteWorkflowAsset,
    uploadWorkflowAssets,
    uploadWorkflowAssetVersion,
    openExternalUrl,
    reportFault,
} = vi.hoisted(() => ({
    listWorkflowAssets: vi.fn(),
    getWorkflowAssetUrl: vi.fn(),
    deleteWorkflowAsset: vi.fn(),
    uploadWorkflowAssets: vi.fn(),
    uploadWorkflowAssetVersion: vi.fn(),
    openExternalUrl: vi.fn(),
    reportFault: vi.fn((reason: unknown) => ({
        message: reason instanceof Error ? reason.message : "fault",
    })),
}));

vi.mock("../../../word-addin/src/taskpane/api/mikeApi", () => ({
    listWorkflowAssets,
    getWorkflowAssetUrl,
    deleteWorkflowAsset,
    uploadWorkflowAssets,
    uploadWorkflowAssetVersion,
    MikeApiError,
}));

vi.mock("../../../word-addin/src/taskpane/lib/openExternalUrl", () => ({
    openExternalUrl,
}));

vi.mock("../../../word-addin/src/taskpane/lib/notify", () => ({
    reportFault,
}));

import { WorkflowAssets } from "../../../word-addin/src/taskpane/components/workflows/WorkflowAssets";

const asset = {
    id: "asset-1",
    filename: "Draft.docx",
    file_type: "docx",
    size_bytes: 12,
    created_at: "2026-11-21T00:00:00.000Z",
};

describe("Word add-in WorkflowAssets AI-draft confirm (N48)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        listWorkflowAssets.mockResolvedValue([asset]);
    });

    it("asks in the taskpane instead of window.confirm, then retries with the token", async () => {
        const confirm = vi.spyOn(window, "confirm");
        getWorkflowAssetUrl.mockRejectedValueOnce(
            new MikeApiError({
                message: "unresolved AI edits",
                status: 409,
                code: "unresolved_ai_edits",
                details: { confirm_token: "token-1" },
            }),
        );
        getWorkflowAssetUrl.mockResolvedValueOnce({
            url: "https://files.example/draft.docx",
            filename: "[KI-ENTWURF] Draft.docx",
        });

        render(<WorkflowAssets workflowId="workflow-1" readOnly />);
        await screen.findByText("Draft.docx");
        fireEvent.click(screen.getByRole("button", { name: "Download" }));

        expect(
            await screen.findByRole("dialog", { name: "Export AI draft?" }),
        ).toBeVisible();
        expect(
            screen.getByText(
                "KI-Entwurf, nicht freigegeben. Download mit Kennzeichnung?",
            ),
        ).toBeVisible();
        expect(confirm).not.toHaveBeenCalled();
        expect(openExternalUrl).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "Export anyway" }));
        await waitFor(() =>
            expect(getWorkflowAssetUrl).toHaveBeenCalledWith(
                "asset-1",
                "token-1",
            ),
        );
        expect(openExternalUrl).toHaveBeenCalledWith(
            "https://files.example/draft.docx",
        );
        expect(
            screen.queryByRole("dialog", { name: "Export AI draft?" }),
        ).toBeNull();
    });

    it("cancels the taskpane confirm without downloading", async () => {
        getWorkflowAssetUrl.mockRejectedValueOnce(
            new MikeApiError({
                message: "unresolved AI edits",
                status: 409,
                code: "unresolved_ai_edits",
                details: { confirm_token: "token-1" },
            }),
        );

        render(<WorkflowAssets workflowId="workflow-1" readOnly />);
        await screen.findByText("Draft.docx");
        fireEvent.click(screen.getByRole("button", { name: "Download" }));
        fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

        expect(getWorkflowAssetUrl).toHaveBeenCalledTimes(1);
        expect(openExternalUrl).not.toHaveBeenCalled();
        expect(screen.queryByRole("dialog")).toBeNull();
    });
});
