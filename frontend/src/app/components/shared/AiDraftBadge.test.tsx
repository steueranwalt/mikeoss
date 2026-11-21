import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { AiDraftBadge } from "./AiDraftBadge";

it("renders the KI-Entwurf marker", () => {
    render(<AiDraftBadge />);
    expect(screen.getByText("KI-Entwurf")).toBeVisible();
});
