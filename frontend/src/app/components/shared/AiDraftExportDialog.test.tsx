import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AiDraftExportDialog } from "./AiDraftExportDialog";

const details = {
    confirmToken: "token-abc",
    versionId: "version-1",
    pendingEditIds: ["edit-1"],
    aiDraft: true,
};

it("binds the confirmation to version_id, pending edit ids and confirm_token", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
        <AiDraftExportDialog
            open
            details={details}
            onConfirm={onConfirm}
            onCancel={onCancel}
        />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Export AI draft?");
    expect(dialog).toHaveTextContent("version-1");
    expect(dialog).toHaveTextContent("edit-1");
    expect(dialog).toHaveTextContent("token-abc");
    fireEvent.click(screen.getByRole("button", { name: "Export anyway" }));
    expect(onConfirm).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
});
