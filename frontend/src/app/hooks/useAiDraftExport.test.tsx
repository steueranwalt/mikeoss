import { useLayoutEffect } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { MikeApiError } from "@/app/lib/mikeApi";
import { useAiDraftExport } from "./useAiDraftExport";

function setup() {
    let hook!: ReturnType<typeof useAiDraftExport>;
    render(<Harness />);
    function Harness() {
        const value = useAiDraftExport();
        useLayoutEffect(() => {
            hook = value;
        });
        return value.dialog;
    }
    return () => hook;
}

function refusal() {
    return new MikeApiError({
        message: "This document has AI-proposed changes.",
        status: 409,
        code: "unresolved_ai_edits",
        details: {
            confirm_token: "token-1",
            version_id: "version-1",
            pending_edit_ids: ["edit-1"],
            ai_draft: true,
        },
    });
}

it("retries the export with the 409 confirm_token after the user confirms", async () => {
    const hook = setup();
    const action = vi
        .fn()
        .mockRejectedValueOnce(refusal())
        .mockResolvedValueOnce("ok");
    let result!: Promise<string>;
    act(() => {
        result = hook().confirmExport(action);
    });
    expect(await screen.findByRole("dialog")).toHaveTextContent("version-1");
    expect(screen.getByRole("dialog")).toHaveTextContent("token-1");
    expect(action).toHaveBeenCalledWith();
    await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Export anyway" }));
        await result;
    });
    expect(action).toHaveBeenLastCalledWith("token-1");
    expect(await result).toBe("ok");
});

it("retries a zip export with per-document confirm_tokens after the user confirms (N26)", async () => {
    const hook = setup();
    const action = vi
        .fn()
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
        .mockResolvedValueOnce("ok");
    let result!: Promise<string>;
    act(() => {
        result = hook().confirmZipExport(action);
    });
    expect(await screen.findByRole("dialog")).toHaveTextContent("one.docx");
    await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Export anyway" }));
        await result;
    });
    expect(action).toHaveBeenLastCalledWith({ "doc-1": "token-1" });
    expect(await result).toBe("ok");
});

it("does not retry when the user cancels", async () => {
    const hook = setup();
    const action = vi.fn().mockRejectedValue(refusal());
    let result!: Promise<unknown>;
    act(() => {
        result = hook().confirmExport(action);
    });
    await screen.findByRole("dialog");
    await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        await expect(result).rejects.toMatchObject({ name: "AiDraftExportCancelled" });
    });
    expect(action).toHaveBeenCalledOnce();
});
