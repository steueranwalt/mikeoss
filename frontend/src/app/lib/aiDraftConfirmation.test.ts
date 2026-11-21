import { describe, expect, it } from "vitest";
import { MikeApiError } from "./mikeApi";
import {
    unresolvedAiEditsFromError,
    unresolvedAiEditsZipFromError,
} from "./aiDraftConfirmation";

function error(overrides: Partial<ConstructorParameters<typeof MikeApiError>[0]> = {}) {
    return new MikeApiError({
        message: "This document has AI-proposed changes.",
        status: 409,
        code: "unresolved_ai_edits",
        details: {
            confirm_token: "abc",
            version_id: "version-1",
            pending_edit_ids: ["edit-1", "edit-2"],
            ai_draft: true,
        },
        ...overrides,
    });
}

describe("unresolvedAiEditsFromError", () => {
    it("reads confirm_token, version_id, pending_edit_ids and ai_draft from a 409", () => {
        expect(unresolvedAiEditsFromError(error())).toEqual({
            confirmToken: "abc",
            versionId: "version-1",
            pendingEditIds: ["edit-1", "edit-2"],
            aiDraft: true,
        });
    });

    it("rejects anything that is not a bound 409 unresolved_ai_edits body", () => {
        expect(unresolvedAiEditsFromError(new Error("no"))).toBeNull();
        expect(unresolvedAiEditsFromError(error({ status: 400 }))).toBeNull();
        expect(unresolvedAiEditsFromError(error({ code: "stamping_failed" }))).toBeNull();
        expect(
            unresolvedAiEditsFromError(
                error({ details: { confirm_token: "abc", version_id: "v1" } }),
            ),
        ).toBeNull();
        expect(
            unresolvedAiEditsFromError(
                error({
                    details: {
                        confirm_token: "abc",
                        version_id: "v1",
                        pending_edit_ids: "not-an-array",
                    },
                }),
            ),
        ).toBeNull();
    });

    it("reads a zip-batch 409's per-document confirm_tokens (N26)", () => {
        expect(
            unresolvedAiEditsZipFromError(
                error({
                    details: {
                        documents: [
                            {
                                document_id: "doc-1",
                                filename: "one.docx",
                                confirm_token: "token-1",
                            },
                            {
                                document_id: "doc-2",
                                filename: "two.docx",
                                confirm_token: "token-2",
                            },
                        ],
                    },
                }),
            ),
        ).toEqual([
            { documentId: "doc-1", filename: "one.docx", confirmToken: "token-1" },
            { documentId: "doc-2", filename: "two.docx", confirmToken: "token-2" },
        ]);
    });

    it("treats a missing ai_draft flag as false, matching a pending-edits-only 409", () => {
        expect(
            unresolvedAiEditsFromError(
                error({
                    details: {
                        confirm_token: "abc",
                        version_id: "v1",
                        pending_edit_ids: [],
                    },
                }),
            ),
        ).toMatchObject({ aiDraft: false, pendingEditIds: [] });
    });
});
