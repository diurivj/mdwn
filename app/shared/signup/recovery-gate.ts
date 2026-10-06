export const RECOVERY_CONFIRMATION_GATE_KEY = "mdwn:signup:recovery-confirmation-pending";

export class RecoveryConfirmationPendingError extends Error {
  constructor() {
    super("recovery_confirmation_pending");
  }
}

/** A pending local gate blocks private content creation; unreadable storage fails closed. */
export function isSignupRecoveryConfirmationPending(): boolean {
  try {
    return typeof window !== "undefined" && localStorage.getItem(RECOVERY_CONFIRMATION_GATE_KEY) !== null;
  } catch {
    return true;
  }
}

export function confirmSignupRecovery(): void {
  localStorage.removeItem(RECOVERY_CONFIRMATION_GATE_KEY);
}
