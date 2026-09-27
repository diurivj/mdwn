import { afterEach, describe, expect, it, vi } from "vitest";

import { clientAction, clientLoader } from "../app/routes/resources/sharing";
import { stageShareInviteAction } from "../app/sharing/client";

afterEach(() => vi.unstubAllGlobals());

function callRouteHandler(handler: (args: never) => unknown, request: Request): Promise<unknown> {
  return Reflect.apply(handler, undefined, [{ request }]) as Promise<unknown>;
}

describe("browser sharing resource route", () => {
  it("loads no private data for an invalid collection request", async () => {
    const result = await callRouteHandler(clientLoader, new Request(
      "https://mdwn.test/resources/sharing?collection=unknown",
    ));

    expect(result).toEqual({ state: "error", collection: "unknown" });
  });

  it("runs a staged Share invite once through clientAction using the router request signal", async () => {
    let executions = 0;
    let actionSignal: AbortSignal | undefined;
    const operationId = stageShareInviteAction(async (signal) => {
      executions++;
      actionSignal = signal;
      return "018f0000-0000-7000-8000-000000000501";
    });
    const body = new FormData();
    body.set("intent", "invite");
    body.set("operationId", operationId);
    const request = new Request("https://mdwn.test/resources/sharing", { method: "POST", body });

    const result = await callRouteHandler(clientAction, request);
    expect(result).toEqual({ state: "success", intent: "invite",
      itemId: "018f0000-0000-7000-8000-000000000501", message: "Invitation sent." });
    expect(actionSignal).toBe(request.signal);
    expect(executions).toBe(1);
  });
});
