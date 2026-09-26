import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("sign-in", "routes/sign-in.tsx"),
  route("sign-up", "routes/sign-up.tsx"),
  route("recover", "routes/recover.tsx"),
  route("account/security", "routes/account-security.tsx"),
  route("account/device-access", "routes/device-access.tsx"),
  route("api/auth/recovery/*", "routes/api/auth-recovery.ts"),
  route("api/auth/*", "routes/auth.ts"),
  route("api/signup/*", "routes/signup.ts"),
  route("api/device/state", "routes/device-state.ts"),
  route("api/private/bootstrap", "routes/private-bootstrap.ts"),
  route("healthz", "routes/healthz.ts"),
  route("robots.txt", "routes/robots.txt.ts"),
] satisfies RouteConfig;
