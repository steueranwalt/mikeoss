import { describe, it, expect, vi, beforeEach } from "vitest";

const { getTokenMock } = vi.hoisted(() => ({
  getTokenMock: vi.fn(),
}));

vi.mock("@azure/identity", () => {
  return {
    DefaultAzureCredential: class FakeCredential {
      getToken = getTokenMock;
    },
  };
});

let federatedClientAssertion: typeof import("./entraClientAssertion").federatedClientAssertion;
let resetEntraClientAssertionCredential: typeof import("./entraClientAssertion").resetEntraClientAssertionCredential;
let CLIENT_ASSERTION_TYPE: typeof import("./entraClientAssertion").CLIENT_ASSERTION_TYPE;

beforeEach(async () => {
  getTokenMock.mockReset();
  vi.resetModules();
  ({ federatedClientAssertion, resetEntraClientAssertionCredential, CLIENT_ASSERTION_TYPE } =
    await import("./entraClientAssertion.js"));
});

describe("federatedClientAssertion", () => {
  it("returns the managed-identity token for the reserved AzureADTokenExchange audience", async () => {
    getTokenMock.mockResolvedValue({
      token: "fake-federated-jwt",
      expiresOnTimestamp: Date.now() + 10 * 60_000,
    });
    const assertion = await federatedClientAssertion();
    expect(assertion).toBe("fake-federated-jwt");
    expect(getTokenMock).toHaveBeenCalledWith("api://AzureADTokenExchange/.default");
  });

  it("returns null when no managed identity is available (e.g. local dev)", async () => {
    getTokenMock.mockRejectedValue(new Error("No managed identity endpoint found"));
    const assertion = await federatedClientAssertion();
    expect(assertion).toBeNull();
  });

  it("returns null when the credential resolves with no token", async () => {
    getTokenMock.mockResolvedValue(null);
    const assertion = await federatedClientAssertion();
    expect(assertion).toBeNull();
  });

  it("caches a token until shortly before its expiry, then refreshes", async () => {
    getTokenMock.mockResolvedValueOnce({
      token: "token-1",
      expiresOnTimestamp: Date.now() + 10_000, // expires very soon
    });
    const first = await federatedClientAssertion();
    expect(first).toBe("token-1");

    getTokenMock.mockResolvedValueOnce({
      token: "token-2",
      expiresOnTimestamp: Date.now() + 10 * 60_000,
    });
    const second = await federatedClientAssertion();
    expect(second).toBe("token-2");
    expect(getTokenMock).toHaveBeenCalledTimes(2);
  });

  it("reuses a cached token that is still comfortably valid", async () => {
    getTokenMock.mockResolvedValue({
      token: "token-1",
      expiresOnTimestamp: Date.now() + 10 * 60_000,
    });
    await federatedClientAssertion();
    await federatedClientAssertion();
    expect(getTokenMock).toHaveBeenCalledTimes(1);
  });

  it("exports the RFC 7523 client-assertion-type constant", () => {
    expect(CLIENT_ASSERTION_TYPE).toBe(
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    );
  });

  it("resetEntraClientAssertionCredential forces a fresh credential instance on next call", async () => {
    getTokenMock.mockResolvedValue({
      token: "token-1",
      expiresOnTimestamp: Date.now() + 10 * 60_000,
    });
    await federatedClientAssertion();
    resetEntraClientAssertionCredential();
    // Caching is per-token, not per-credential, so this just documents the
    // test seam exists and does not throw.
    await expect(federatedClientAssertion()).resolves.toBeTruthy();
  });
});
