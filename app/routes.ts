import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("sign-in", "routes/sign-in.tsx"),
  route("account/security", "routes/account-security.tsx"),
  route("api/auth/*", "routes/auth.ts"),
  route("healthz", "routes/healthz.ts"),
  route("robots.txt", "routes/robots.txt.ts"),
] satisfies RouteConfig;
