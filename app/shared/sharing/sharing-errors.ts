import { PrivateAccessError } from "~/shared/device/private-client";
import { RecoveryConfirmationPendingError } from "~/shared/signup/recovery-gate";
import {
  AlreadySharedError,
  KeyRotationRequiredError,
  SharingChangedError,
  SharingNotFoundError,
  SharingPageLimitError,
} from "./relationships-client";
import { SharePreparationError } from "./share-staging-client";

/** Every sharing surface's failure outcomes; each surface words them for its own action. */
export type SharingFailure =
  | "changed"
  | "not-found"
  | "sealed"
  | "already-shared"
  | "missing-source"
  | "too-large"
  | "access"
  | "recovery"
  | "failed";

/** The one mapping from sharing, preparation and access errors to an outcome. */
export function sharingFailure(error: unknown): SharingFailure {
  if (error instanceof SharePreparationError) return error.reason === "unavailable" ? "failed" : error.reason;
  if (error instanceof SharingChangedError) return "changed";
  if (error instanceof SharingNotFoundError) return "not-found";
  if (error instanceof KeyRotationRequiredError) return "sealed";
  if (error instanceof AlreadySharedError) return "already-shared";
  if (error instanceof SharingPageLimitError) return "too-large";
  if (error instanceof RecoveryConfirmationPendingError) return "recovery";
  if (error instanceof PrivateAccessError) return "access";
  return "failed";
}
