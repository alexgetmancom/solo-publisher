import { describe, expect, it } from "bun:test";
import { checkFamilyRoutes } from "./check-family-routes.ts";

function configuration() {
  const proxy = {
    handler: "reverse_proxy",
    upstreams: [{ dial: "192.168.10.106:8787" }],
    headers: { request: { set: { "X-Real-Ip": ["{http.request.remote.host}"] }, delete: [] as string[] } },
  };
  const routes = [
    { handle: [{ handler: "encode" }] },
    {
      match: [{ path: ["/presence/place", "/presence/point"] }],
      handle: [{ handler: "subroute", routes: [{ handle: [proxy] }] }],
    },
    { handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "127.0.0.1:8792" }] }] },
  ];
  const config = {
    apps: {
      http: {
        servers: {
          srv0: {
            routes: [
              {
                match: [{ host: ["alexgetman.com"] }],
                handle: [{ handler: "subroute", routes }],
              },
            ],
          },
        },
      },
    },
  };
  return { config, routes, proxy };
}

describe("Family phone routes in the adapted host proxy", () => {
  it("accepts the phone intake alongside normal site middleware", () => {
    expect(() => checkFamilyRoutes(configuration().config)).not.toThrow();
  });

  it("rejects losing the phone route during a site configuration replacement", () => {
    const { config, routes } = configuration();
    routes.splice(1, 1);
    expect(() => checkFamilyRoutes(config)).toThrow("route is missing");
  });

  it("rejects routing phone POSTs to the website instead of Family", () => {
    const { config, proxy } = configuration();
    if (!proxy?.upstreams?.[0]) throw new Error("fixture proxy missing");
    proxy.upstreams[0].dial = "127.0.0.1:8792";
    expect(() => checkFamilyRoutes(config)).toThrow("not the website");
  });

  it("rejects a website fallback that shadows the phone route", () => {
    const { config, routes } = configuration();
    routes.reverse();
    expect(() => checkFamilyRoutes(config)).toThrow("must precede");
  });

  it("rejects dropping the phone's authentication header", () => {
    const { config, proxy } = configuration();
    proxy.headers.request.delete.push("X-Family-Token");
    expect(() => checkFamilyRoutes(config)).toThrow("authentication token");
  });
});
