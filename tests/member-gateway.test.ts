import { expect, test } from "bun:test";
import {
  createMemberBinding,
  createMemberGatewayHandler,
  isPeerOnSelectedSubnet,
  reconcileMemberBinding,
} from "../src/member-gateway.ts";

const selected = {
  name: "en0",
  address: "192.168.50.20",
  netmask: "255.255.255.0",
};

test("Member Link uses the selected private address, actual Bonjour name, and offline QR", async () => {
  const binding = await createMemberBinding({
    selected,
    available: [selected, { name: "utun4", address: "10.9.0.2", netmask: "255.255.0.0" }],
    bonjourName: "localhub-test.local",
    port: 39283,
  });

  expect(binding.interface).toEqual(selected);
  expect(binding.friendlyUrl).toBe("http://localhub-test.local:39283");
  expect(binding.ipv4Url).toBe("http://192.168.50.20:39283");
  expect(binding.qrSvg).toContain("<svg");
  expect(binding.qrPayload).toBe(binding.ipv4Url);
  expect(binding.qrSvg).not.toContain("api.qr");
});

test("network change and wake recheck withdraw stale Member publication without substitution", async () => {
  const binding = await createMemberBinding({
    selected,
    available: [selected],
    bonjourName: "localhub-test.local",
    port: 39283,
  });

  expect(reconcileMemberBinding(binding, [selected])).toEqual({ status: "current" });
  const changed = reconcileMemberBinding(binding, [{ ...selected, address: "192.168.50.21" }]);
  expect(changed).toMatchObject({
    status: "withdrawn",
    failure: {
      cause: expect.stringContaining("changed"),
      protectedState: expect.stringContaining("old Member Link is closed"),
      repair: expect.stringContaining("recheck"),
      recheck: expect.stringContaining("recheck"),
    },
  });
  expect(JSON.stringify(changed)).not.toContain("192.168.50.21");
});

test("Member binding refuses public, loopback, wildcard, stale, or silently substituted addresses", async () => {
  for (const address of ["203.0.113.8", "127.0.0.1", "0.0.0.0", "169.254.1.2"]) {
    await expect(
      createMemberBinding({
        selected: { name: "en0", address, netmask: "255.255.255.0" },
        available: [{ name: "en0", address, netmask: "255.255.255.0" }],
        bonjourName: "localhub-test.local",
        port: 39283,
      }),
    ).rejects.toThrow();
  }

  await expect(
    createMemberBinding({
      selected,
      available: [{ ...selected, address: "192.168.50.21" }],
      bonjourName: "localhub-test.local",
      port: 39283,
    }),
  ).rejects.toThrow("changed");
});

test("Member listener accepts only the selected subnet and exposes no Host routes", async () => {
  const binding = await createMemberBinding({
    selected,
    available: [selected],
    bonjourName: "localhub-test.local",
    port: 39283,
  });
  expect(isPeerOnSelectedSubnet("192.168.50.99", binding.interface)).toBe(true);
  expect(isPeerOnSelectedSubnet("192.168.51.99", binding.interface)).toBe(false);
  expect(isPeerOnSelectedSubnet("127.0.0.1", binding.interface)).toBe(false);

  const allowed = createMemberGatewayHandler(binding, () => "192.168.50.99");
  const page = await allowed(
    new Request("http://192.168.50.20:39283/", {
      headers: { host: "192.168.50.20:39283" },
    }),
  );
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
  expect(await page.text()).toContain("passing Shared Model is still required");

  const hostRoute = await allowed(
    new Request("http://192.168.50.20:39283/stop", {
      method: "POST",
      headers: { host: "192.168.50.20:39283", origin: "http://192.168.50.20:39283" },
    }),
  );
  expect(hostRoute.status).toBe(404);

  const wrongSubnet = createMemberGatewayHandler(binding, () => "192.168.51.99");
  const denied = await wrongSubnet(
    new Request("http://192.168.50.20:39283/", {
      headers: { host: "192.168.50.20:39283" },
    }),
  );
  expect(denied.status).toBe(403);
});
