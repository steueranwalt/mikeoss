import { describe, it, expect, vi, beforeEach } from "vitest";

const { federatedClientAssertionMock } = vi.hoisted(() => ({
  federatedClientAssertionMock: vi.fn(),
}));

vi.mock("../../lib/auth/providers/entraClientAssertion", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/auth/providers/entraClientAssertion")
  >("../../lib/auth/providers/entraClientAssertion");
  return { ...actual, federatedClientAssertion: federatedClientAssertionMock };
});

let buildEntraTokenForm: typeof import("./auth.routes").buildEntraTokenForm;

beforeEach(async () => {
  federatedClientAssertionMock.mockReset();
  vi.resetModules();
  ({ buildEntraTokenForm } = await import("./auth.routes.js"));
});

describe("buildEntraTokenForm", () => {
  const creds = { clientId: "client-id", clientSecret: "shh-secret", scopes: "openid profile" };
  const grant = {
    grant_type: "authorization_code" as const,
    code: "auth-code",
    redirect_uri: "https://example.invalid/api/auth/openid-callback/microsoft",
  };

  it("uses client_assertion and omits client_secret when a federated credential is available", async () => {
    federatedClientAssertionMock.mockResolvedValue("federated-jwt");
    const form = await buildEntraTokenForm(creds, grant);
    expect(form.get("client_assertion")).toBe("federated-jwt");
    expect(form.get("client_assertion_type")).toBe(
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    );
    expect(form.has("client_secret")).toBe(false);
  });

  it("falls back to client_secret when no federated credential is available", async () => {
    federatedClientAssertionMock.mockResolvedValue(null);
    const form = await buildEntraTokenForm(creds, grant);
    expect(form.get("client_secret")).toBe("shh-secret");
    expect(form.has("client_assertion")).toBe(false);
    expect(form.has("client_assertion_type")).toBe(false);
  });

  it("sends neither credential when both a federated credential and a secret are unavailable", async () => {
    federatedClientAssertionMock.mockResolvedValue(null);
    const form = await buildEntraTokenForm({ ...creds, clientSecret: undefined }, grant);
    expect(form.has("client_secret")).toBe(false);
    expect(form.has("client_assertion")).toBe(false);
  });

  it("carries the grant and client id/scope through unchanged", async () => {
    federatedClientAssertionMock.mockResolvedValue(null);
    const form = await buildEntraTokenForm(creds, grant);
    expect(form.get("client_id")).toBe("client-id");
    expect(form.get("scope")).toBe("openid profile");
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("auth-code");
    expect(form.get("redirect_uri")).toBe(grant.redirect_uri);
  });
});
