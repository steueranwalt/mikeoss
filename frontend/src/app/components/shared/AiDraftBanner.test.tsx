import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { AiDraftBanner } from "./AiDraftBanner";

it("announces the unapproved AI draft over the viewer", () => {
    render(<AiDraftBanner />);
    expect(screen.getByRole("status")).toHaveTextContent(
        "KI-Entwurf, nicht freigegeben",
    );
});
