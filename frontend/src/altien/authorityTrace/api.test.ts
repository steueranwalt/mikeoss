import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MikeApiError } from "@/app/lib/mikeApi";

const { getAuthHeader, bounceIfUnauthorized } = vi.hoisted(() => ({
    getAuthHeader: vi.fn(async () => ({ Authorization: "Bearer tok" })),
    bounceIfUnauthorized: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    getAuthHeader,
    API_BASE: "http://localhost/api",
}));

vi.mock("@/app/lib/auth-token", () => ({
    bounceIfUnauthorized,
    getBrowserAccessToken: vi.fn(async () => "tok"),
}));

import { downloadAuthorityTraceExport } from "./api";

describe("downloadAuthorityTraceExport (N38)", () => {
    const click = vi.fn();

    beforeEach(() => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                if (String(url).includes("confirm_token=token-1")) {
                    return new Response("<html></html>", {
                        status: 200,
                        headers: {
                            "content-disposition":
                                'attachment; filename="[KI-ENTWURF] authority-trace-run-1-review.html"',
                        },
                    });
                }
                return new Response(
                    JSON.stringify({
                        code: "unresolved_ai_edits",
                        detail: "Confirm the download",
                        confirm_token: "token-1",
                        version_id: "memo-v1",
                        pending_edit_ids: [],
                        ai_draft: true,
                    }),
                    {
                        status: 409,
                        headers: { "content-type": "application/json" },
                    },
                );
            }),
        );
        click.mockReset();
        vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:at");
        vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
        vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(click);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("requires download=1 and a confirm token, then saves with a [KI-ENTWURF] prefix", async () => {
        await expect(
            downloadAuthorityTraceExport("run-1", "review"),
        ).rejects.toMatchObject({
            status: 409,
            code: "unresolved_ai_edits",
        } satisfies Partial<MikeApiError>);

        const blocked = vi.mocked(fetch).mock.calls[0]?.[0];
        expect(String(blocked)).toContain("download=1");
        expect(String(blocked)).not.toContain("confirm_token=");

        await downloadAuthorityTraceExport("run-1", "review", {
            confirmToken: "token-1",
        });

        const confirmed = vi.mocked(fetch).mock.calls[1]?.[0];
        expect(String(confirmed)).toContain("download=1");
        expect(String(confirmed)).toContain("confirm_token=token-1");
        expect(click).toHaveBeenCalledOnce();
        expect(click.mock.instances[0]).toHaveAttribute(
            "download",
            "[KI-ENTWURF] authority-trace-run-1-review.html",
        );
    });
});
