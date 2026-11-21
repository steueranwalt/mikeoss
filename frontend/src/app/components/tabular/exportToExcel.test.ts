import { afterEach, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import {
    exportTabularReviewToExcel,
    TABULAR_AI_DRAFT_NOTICE,
} from "./exportToExcel";

afterEach(() => {
    vi.restoreAllMocks();
});

it("prefixes the filename and writes a KI notice sheet (N42)", async () => {
    let blob: Blob | null = null;
    vi.spyOn(URL, "createObjectURL").mockImplementation((value) => {
        blob = value as Blob;
        return "blob:xlsx";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const click = vi
        .spyOn(HTMLAnchorElement.prototype, "click")
        .mockImplementation(() => {});

    await exportTabularReviewToExcel({
        reviewTitle: "Diligence / Q3",
        columns: [{ index: 0, name: "Issue", prompt: "What?" }],
        rows: [
            {
                id: "row-1",
                review_id: "r1",
                label: "Memo",
                row_type: "document",
                folder_id: null,
                library_folder_id: null,
                document_id: "d1",
                sort_index: 0,
                source_document_ids: ["d1"],
            },
        ],
        cells: [
            {
                id: "cell-1",
                review_id: "r1",
                row_id: "row-1",
                document_id: "d1",
                column_index: 0,
                content: { summary: "Answer" },
                status: "done",
                created_at: "2026-01-01T00:00:00.000Z",
                ai_draft: true,
            },
        ],
    });

    expect(click).toHaveBeenCalled();
    const anchor = click.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(anchor.download).toBe("[KI-ENTWURF] Diligence Q3.xlsx");
    expect(blob).not.toBeNull();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await blob!.arrayBuffer());
    expect(wb.getWorksheet("KI-Hinweis")?.getRow(1).getCell(1).value).toBe(
        TABULAR_AI_DRAFT_NOTICE,
    );
    expect(wb.getWorksheet("Review")?.getRow(1).getCell(1).value).toBe(
        "KI-Entwurf, nicht freigegeben",
    );
});

it("marks the Review sheet header as an unapproved AI draft (N42)", async () => {
    let blob: Blob | null = null;
    vi.spyOn(URL, "createObjectURL").mockImplementation((value) => {
        blob = value as Blob;
        return "blob:xlsx";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
        () => {},
    );

    await exportTabularReviewToExcel({
        reviewTitle: "Diligence / Q3",
        columns: [{ index: 0, name: "Issue", prompt: "What?" }],
        rows: [
            {
                id: "row-1",
                review_id: "r1",
                label: "Memo",
                row_type: "document",
                folder_id: null,
                library_folder_id: null,
                document_id: "d1",
                sort_index: 0,
                source_document_ids: ["d1"],
            },
        ],
        cells: [
            {
                id: "cell-1",
                review_id: "r1",
                row_id: "row-1",
                document_id: "d1",
                column_index: 0,
                content: { summary: "Answer" },
                status: "done",
                created_at: "2026-01-01T00:00:00.000Z",
                ai_draft: true,
            },
        ],
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await blob!.arrayBuffer());
    const review = wb.getWorksheet("Review");
    expect(review?.getRow(1).getCell(1).value).toBe(
        "KI-Entwurf, nicht freigegeben",
    );
    expect(review?.getRow(2).getCell(1).value).toBe("Folder / document");
    expect(review?.getRow(2).getCell(2).value).toBe("Issue");
    expect(review?.getRow(3).getCell(1).value).toBe("Memo");
    expect(review?.getRow(3).getCell(2).value).toBe("Answer");
});
