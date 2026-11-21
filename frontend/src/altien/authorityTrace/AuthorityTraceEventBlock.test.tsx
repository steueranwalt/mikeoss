import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { AuthorityTraceEventBlock } from "./AuthorityTraceEventBlock";

it("labels Authority Trace status as a KI-Entwurf", () => {
    render(
        <AuthorityTraceEventBlock
            event={{
                type: "authority_trace_verification",
                isStreaming: false,
                outcome: "success",
                total: 1,
                anchored: 1,
                exact: 1,
                failed: 0,
                run_id: "run-1",
            }}
        />,
    );
    expect(screen.getByText(/KI-Entwurf/)).toBeVisible();
    expect(screen.getByText(/Authority Trace completed/)).toBeVisible();
});
