"use client";

import { apiUrl } from "./api";

// Re-exported for the callers that historically imported it from here —
// the value itself is owned by lib/api.ts.
export { apiUrl };

export interface UserIdentity {
  id: string;
  display_name: string;
  personal_meeting_id: string;
}

export const DEFAULT_DISPLAY_NAME = "Ruchir Tripathi";

// In-flight dedupe for the identity registration. React StrictMode invokes
// the mount effect twice in development, and two concurrent identical
// preflighted POSTs make Chrome fail one of them with a spurious CORS
// error — every caller must share a single in-flight request. Cleared on
// settlement so a later retry (e.g. the New meeting flow) still fetches.
let identityInFlight: Promise<UserIdentity> | null = null;

export function readStoredIdentity(): { id: string; displayName: string } {
  const id = localStorage.getItem("meetspace_user_id") || crypto.randomUUID();
  const displayName = localStorage.getItem("meetspace_display_name") || DEFAULT_DISPLAY_NAME;
  localStorage.setItem("meetspace_user_id", id);
  localStorage.setItem("meetspace_display_name", displayName);
  return { id, displayName };
}

/**
 * Registers (or reactivates) the browser's app identity and returns it.
 * Shared by the dashboard, the meetings page and the join lobby — there is
 * exactly one identity per browser, created lazily on first use.
 */
export function ensureIdentity(): Promise<UserIdentity> {
  if (!identityInFlight) {
    identityInFlight = (async () => {
      const { id, displayName } = readStoredIdentity();
      const response = await fetch(`${apiUrl}/api/users/me`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, display_name: displayName }),
      });
      if (!response.ok) throw new Error("Unable to register meeting identity");
      return (await response.json()) as UserIdentity;
    })().finally(() => { identityInFlight = null; });
  }
  return identityInFlight;
}
