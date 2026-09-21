import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("healthz", "routes/healthz.ts"),
  route("robots.txt", "routes/robots.txt.ts"),
  route("__test/enc-v1", "routes/enc-v1-test.tsx"),
] satisfies RouteConfig;