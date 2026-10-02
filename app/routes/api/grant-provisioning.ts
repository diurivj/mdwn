import { getEnv } from "~/context/env";
import { provisioningAction } from "~/sharing/provisioning.server";
import type { Route } from "./+types/grant-provisioning";

export function action({ request, context }: Route.ActionArgs) {
  return provisioningAction(request, getEnv(context));
}
