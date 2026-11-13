type Matcher = { host?: string[]; path?: string[]; method?: string[] };
type Handler = {
  handler?: string;
  routes?: Route[];
  upstreams?: { dial?: string }[];
  headers?: { request?: { set?: Record<string, string[]>; delete?: string[] } };
};
type Route = { match?: Matcher[]; handle?: Handler[] };
type Config = { apps?: { http?: { servers?: Record<string, { routes?: Route[] }> } } };

function handlers(route: Route): Handler[] {
  return (route.handle ?? []).flatMap((handler) => [handler, ...(handler.routes ?? []).flatMap(handlers)]);
}

export function checkFamilyRoutes(config: Config): void {
  const routes = Object.values(config.apps?.http?.servers ?? {}).flatMap((server) => server.routes ?? []);
  const site = routes.find((route) => route.match?.some((match) => match.host?.includes("alexgetman.com")));
  if (!site) throw new Error("Family: alexgetman.com host route is missing");
  const siteRoutes = (site.handle ?? []).flatMap((handler) => handler.routes ?? []);
  const paths = ["/presence/point", "/presence/place"];
  for (const path of paths) {
    const route = siteRoutes.find((candidate) =>
      candidate.match?.some((match) => match.path?.includes(path) && (!match.method || match.method.includes("POST"))),
    );
    if (!route) throw new Error(`Family: POST ${path} route is missing`);
    const firstProxy = siteRoutes.find((candidate) => handlers(candidate).some((handler) => handler.handler === "reverse_proxy"));
    if (firstProxy !== route) throw new Error(`Family: ${path} must precede the site's proxy routes`);
    const proxies = handlers(route).filter((handler) => handler.handler === "reverse_proxy");
    if (proxies.length !== 1 || proxies[0]?.upstreams?.length !== 1 || proxies[0].upstreams[0]?.dial !== "192.168.10.106:8787") {
      throw new Error(`Family: ${path} must reach the VM106 intake, not the website`);
    }
    const headers = proxies[0].headers?.request;
    if (
      headers?.delete?.some((name) => name === "*" || name.toLowerCase() === "x-family-token") ||
      Object.keys(headers?.set ?? {}).some((name) => name.toLowerCase() === "x-family-token")
    ) {
      throw new Error(`Family: ${path} must preserve the phone's authentication token`);
    }
  }
}

if (import.meta.main) {
  checkFamilyRoutes(JSON.parse(await Bun.stdin.text()) as Config);
  console.log("Family phone routes reach the authenticated VM106 intake before the website.");
}
