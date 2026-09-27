import {
  acceptInvitation, cancelInvitation, changeGrantPermission, declineInvitation, executeShareInviteAction,
  invitations, leaveGrant, revokeGrant, sharedRootsPage,
  type InvitationCursors,
} from "~/sharing/client";
import { isV7 } from "~/tree/wire";
import type { Route } from "./+types/sharing";

const unavailable = "This Share action could not be completed. Refresh and try again.";

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const url = new URL(request.url);
  const collection = url.searchParams.get("collection");
  if (collection === "roots") {
    try {
      return { state: "success", collection, ...(await sharedRootsPage(request.signal,
        url.searchParams.get("cursor"))) } as const;
    } catch (error) {
      if (request.signal.aborted) throw error;
      return { state: "error", collection } as const;
    }
  }
  if (collection === "invitations") {
    const cursors: InvitationCursors = {};
    for (const key of ["incomingCursor", "outgoingCursor", "grantsCursor"] as const) {
      const cursor = url.searchParams.get(key);
      if (cursor) cursors[key] = cursor;
    }
    try {
      return { state: "success", collection, ...(await invitations(request.signal, cursors)) } as const;
    } catch (error) {
      if (request.signal.aborted) throw error;
      return { state: "error", collection } as const;
    }
  }
  return { state: "error", collection } as const;
}

const formString = (form: FormData, name: string): string | null => {
  const value = form.get(name);
  return typeof value === "string" ? value : null;
};

function actionError(intent: string) {
  return { state: "error", intent, message: unavailable } as const;
}

export async function clientAction({ request }: Route.ClientActionArgs) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return actionError("unknown");
  }
  const intent = formString(form, "intent");
  if (!intent) return actionError("unknown");

  if (intent === "invite") {
    const operationId = formString(form, "operationId");
    if (!operationId) return actionError(intent);
    try {
      const itemId = await executeShareInviteAction(operationId, request.signal);
      if (!isV7(itemId)) throw new Error("Invalid Share identifier");
      return { state: "success", intent, itemId, message: "Invitation sent." } as const;
    } catch (error) {
      if (request.signal.aborted) throw error;
      return actionError(intent);
    }
  }

  const itemId = formString(form, "itemId");
  if (!itemId || !isV7(itemId)) return actionError(intent);
  try {
    switch (intent) {
      case "accept":
        await acceptInvitation(itemId, request.signal);
        return { state: "success", intent, itemId, message: "Invitation accepted." } as const;
      case "decline":
        await declineInvitation(itemId, request.signal);
        return { state: "success", intent, itemId, message: "Invitation declined." } as const;
      case "cancel":
        await cancelInvitation(itemId, request.signal);
        return { state: "success", intent, itemId, message: "Invitation canceled." } as const;
      case "leave":
        await leaveGrant(itemId, request.signal);
        return { state: "success", intent, itemId, message: "Share left." } as const;
      case "revoke":
        await revokeGrant(itemId, request.signal);
        return { state: "success", intent, itemId, message: "Share revoked." } as const;
      case "change-permission":
      case "permission": {
        const permission = formString(form, "permission");
        if (permission !== "read_only" && permission !== "read_write") return actionError(intent);
        await changeGrantPermission(itemId, permission, request.signal);
        return { state: "success", intent, itemId, message: "Permission updated." } as const;
      }
      default:
        return actionError(intent);
    }
  } catch (error) {
    if (request.signal.aborted) throw error;
    return actionError(intent);
  }
}
