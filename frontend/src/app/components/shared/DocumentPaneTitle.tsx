import type { ReactNode } from "react";
import { FileTypeIcon } from "./FileTypeIcon";
import { VersionChip } from "./VersionChip";

/**
 * Title row above a side panel's document view: type, name and version.
 * At least h-11 so the panel's other column can start level with the view.
 */
export function DocumentPaneTitle({
    filename,
    fileType,
    versionNumber,
    badge,
    action,
}: {
    filename: string;
    fileType?: string | null;
    versionNumber?: number | null;
    badge?: ReactNode;
    action?: ReactNode;
}) {
    return (
        <div className="flex min-h-11 shrink-0 items-center gap-2 px-3">
            <FileTypeIcon
                fileType={fileType || filename}
                className="h-3.5 w-3.5 shrink-0"
            />
            <div className="flex min-w-0 flex-1 items-center gap-2">
                <h2
                    className="min-w-0 truncate text-xs font-medium text-gray-900"
                    title={filename}
                >
                    {filename}
                </h2>
                <VersionChip n={versionNumber} />
                {badge}
            </div>
            {action}
        </div>
    );
}
