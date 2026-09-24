import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

/** Browser-safe shapes shared by auth resource routes and their consumers. */
export type SessionSummary = {
  id: string;
  createdAt: number;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
  refreshedAt: number | null;
  current: boolean;
};

export type PasskeySummary = {
  id: string;
  createdAt: number;
  current: boolean;
};

export type AssertionStart = {
  challengeId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
  /** Issued only for sign-in: a prospective normal Session's binding digest. */
  sessionBinding?: string;
};

export type RegistrationStart = {
  challengeId: string;
  options: PublicKeyCredentialCreationOptionsJSON;
};

export type RevocationResult = { ok: true; signedOut: boolean };
