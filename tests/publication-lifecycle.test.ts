import { describe, expect, it } from "vitest";

import {
  PublicationError,
  PublicationLifecycle,
  type ActivePublication,
  type AddSelfAuthorInput,
  type ChangeAudienceInput,
  type PreparedPublicLink,
  type PublicationContext,
  type PublicationOperations,
  type PublicationState,
  type PublishInput,
  type RotateLinkInput,
  type TeardownProgress,
} from "../app/shared/publications/lifecycle";

const linkFor = (linkId: string, fragment: string): PreparedPublicLink => ({
  publicationId: "pub-1",
  linkId,
  url: `https://mdwn.test/p/${linkId}#v1.${fragment}`,
});

const baseState = (overrides: Partial<PublicationState> = {}): PublicationState => ({
  fileId: "file-1",
  isOwner: true,
  canEdit: true,
  publication: null,
  comments: null,
  commentCount: 0,
  teardown: null,
  requests: [],
  ...overrides,
});

const activeState = (linkId: string): PublicationState =>
  baseState({
    publication: { publicationId: "pub-1", state: "active", linkId, createdAt: 1, authors: [] },
  });

const deletingState = (): PublicationState =>
  baseState({
    publication: { publicationId: "pub-1", state: "deleting", linkId: null, createdAt: 1, authors: [] },
    teardown: { commentTotal: 4, commentsRemaining: 4 },
  });

function context(overrides: Partial<PublicationContext> = {}): PublicationContext {
  return {
    fileId: "file-1",
    access: {
      vaultId: "vault-1",
      rootId: "root-1",
      rootKey: new Uint8Array(32),
      actorAccountId: "account-1",
      actorVaultRootKey: new Uint8Array(32),
    },
    parentId: "dir-1",
    parentKey: new Uint8Array(32),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Deterministic operations seam: tests replace the handler they control and
 * read the recorded calls/contexts/signals. */
function fakeOperations() {
  const calls: string[] = [];
  const contexts: PublicationContext[] = [];
  const signals: AbortSignal[] = [];
  const record = (method: string, context: PublicationContext, signal: AbortSignal) => {
    calls.push(method);
    contexts.push(context);
    signals.push(signal);
  };
  const handlers = {
    loadState: async (_signal: AbortSignal): Promise<PublicationState> => {
      throw new Error("unexpected loadState");
    },
    loadActivePublication: async (_signal: AbortSignal): Promise<ActivePublication | null> => null,
    publish: async (_input: PublishInput, _signal: AbortSignal): Promise<void> => {},
    rotateLink: async (_input: RotateLinkInput, _signal: AbortSignal): Promise<void> => {},
    changeAudience: async (_input: ChangeAudienceInput, _signal: AbortSignal): Promise<void> => {},
    addSelfAuthor: async (_input: AddSelfAuthorInput, _signal: AbortSignal): Promise<void> => {},
    addAccountAuthor: async (
      _input: { publicationId: string; address: string },
      _signal: AbortSignal,
    ): Promise<void> => {},
    removeAuthor: async (_input: { declarationId: string }, _signal: AbortSignal): Promise<void> => {},
    requestPublication: async (_signal: AbortSignal): Promise<void> => {},
    removePublicationRequest: async (_input: { requestId: string }, _signal: AbortSignal): Promise<void> => {},
    unpublish: async (_signal: AbortSignal): Promise<void> => {},
    continueTeardown: async (_signal: AbortSignal): Promise<TeardownProgress> => ({
      done: true,
      commentTotal: 0,
      commentsRemaining: 0,
    }),
  };
  const operations: PublicationOperations = {
    loadState: (context, signal) => {
      record("loadState", context, signal);
      return handlers.loadState(signal);
    },
    loadActivePublication: (context, signal) => {
      record("loadActivePublication", context, signal);
      return handlers.loadActivePublication(signal);
    },
    publish: (context, input, signal) => {
      record("publish", context, signal);
      return handlers.publish(input, signal);
    },
    rotateLink: (context, input, signal) => {
      record("rotateLink", context, signal);
      return handlers.rotateLink(input, signal);
    },
    changeAudience: (context, input, signal) => {
      record("changeAudience", context, signal);
      return handlers.changeAudience(input, signal);
    },
    addSelfAuthor: (context, input, signal) => {
      record("addSelfAuthor", context, signal);
      return handlers.addSelfAuthor(input, signal);
    },
    addAccountAuthor: (context, input, signal) => {
      record("addAccountAuthor", context, signal);
      return handlers.addAccountAuthor(input, signal);
    },
    removeAuthor: (context, input, signal) => {
      record("removeAuthor", context, signal);
      return handlers.removeAuthor(input, signal);
    },
    requestPublication: (context, signal) => {
      record("requestPublication", context, signal);
      return handlers.requestPublication(signal);
    },
    removePublicationRequest: (context, input, signal) => {
      record("removePublicationRequest", context, signal);
      return handlers.removePublicationRequest(input, signal);
    },
    unpublish: (context, signal) => {
      record("unpublish", context, signal);
      return handlers.unpublish(signal);
    },
    continueTeardown: (context, signal) => {
      record("continueTeardown", context, signal);
      return handlers.continueTeardown(signal);
    },
  };
  return { operations, handlers, calls, contexts, signals };
}

function stateQueue(values: PublicationState[]): () => PublicationState {
  return () => {
    const next = values.shift();
    if (!next) throw new Error("unexpected extra state read");
    return next;
  };
}

describe("PublicationLifecycle", () => {
  it("retains a prepared candidate whose response is lost, then matches the active link", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const link = linkFor("link-1", "one");
    const nextState = stateQueue([baseState(), activeState("link-1")]);
    fake.handlers.loadState = async () => nextState();
    fake.handlers.publish = async (input) => {
      input.onPrepared(link);
      throw new Error("network lost after commit");
    };

    lifecycle.updateContext(context());
    lifecycle.attachPanel();
    await tick();
    expect(lifecycle.getState()).toMatchObject({ panel: "ready", completeLink: null });

    expect(await lifecycle.publish({ includeSelf: false, audience: "public" })).toBe(false);
    expect(fake.calls).toEqual(["loadState", "publish", "loadState"]);
    expect(lifecycle.getState()).toMatchObject({
      panel: "ready",
      completeLink: link.url,
      error: { code: "unavailable", suspendedUntil: null },
    });
  });

  it("keeps the winning candidate when a reopened panel's later attempt loses", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const nextState = stateQueue([baseState(), baseState(), activeState("link-1")]);
    fake.handlers.loadState = async () => nextState();
    const firstLink = linkFor("link-1", "one");
    const secondLink = linkFor("link-2", "two");
    const firstPrepared = deferred<void>();
    const firstCommitted = deferred<void>();
    let attempt = 0;
    fake.handlers.publish = async (input) => {
      attempt += 1;
      if (attempt === 1) {
        input.onPrepared(firstLink);
        firstPrepared.resolve();
        await firstCommitted.promise;
        throw new Error("network lost after commit");
      }
      input.onPrepared(secondLink);
      await firstCommitted.promise;
      throw new PublicationError("exists");
    };

    lifecycle.updateContext(context());
    lifecycle.attachPanel();
    await tick();

    const first = lifecycle.publish({ includeSelf: false, audience: "public" });
    await firstPrepared.promise;
    lifecycle.detachPanel();
    lifecycle.attachPanel();
    await tick();

    const second = lifecycle.publish({ includeSelf: false, audience: "public" });
    firstCommitted.resolve();
    expect(await first).toBe(false);
    expect(await second).toBe(false);

    expect(lifecycle.getState().completeLink).toBe(firstLink.url);
    expect(lifecycle.getState().completeLink).not.toBe(secondLink.url);
    expect(fake.calls.filter((call) => call === "loadState")).toHaveLength(3);
  });

  it("never presents a retained candidate that is not the authoritative active link", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const nextState = stateQueue([baseState(), activeState("link-2")]);
    fake.handlers.loadState = async () => nextState();
    const stale = linkFor("link-1", "one");
    fake.handlers.publish = async (input) => {
      input.onPrepared(stale);
    };

    lifecycle.updateContext(context());
    lifecycle.attachPanel();
    await tick();

    expect(await lifecycle.publish({ includeSelf: false, audience: "public" })).toBe(true);
    expect(lifecycle.getState().completeLink).toBeNull();
  });

  it("ignores an older active-state read that arrives after Unpublishing", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const firstRead = deferred<PublicationState>();
    const nextState = stateQueue([deletingState()]);
    let reads = 0;
    fake.handlers.loadState = async () => {
      reads += 1;
      return reads === 1 ? firstRead.promise : nextState();
    };
    const heldBatch = deferred<TeardownProgress>();
    fake.handlers.continueTeardown = () => heldBatch.promise;

    lifecycle.updateContext(context());
    lifecycle.attachPanel();
    await tick();

    expect(await lifecycle.unpublish()).toBe(true);
    expect(lifecycle.getState().state?.publication?.state).toBe("deleting");

    firstRead.resolve(activeState("link-1"));
    await tick();
    expect(lifecycle.getState().state?.publication?.state).toBe("deleting");
  });

  it("aborts teardown on close, resumes on reopen, and finishes only at final completion", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const nextState = stateQueue([deletingState(), deletingState(), baseState()]);
    fake.handlers.loadState = async () => nextState();
    const heldBatch = deferred<TeardownProgress>();
    const batches: (TeardownProgress | Promise<TeardownProgress>)[] = [
      // Zero remaining Comments is one batch before final completion.
      { done: false, commentTotal: 250, commentsRemaining: 0 },
      heldBatch.promise,
      { done: true, commentTotal: 250, commentsRemaining: 0 },
    ];
    fake.handlers.continueTeardown = async () => batches.shift()!;

    lifecycle.updateContext(context());
    lifecycle.attachPanel();
    await tick();
    expect(fake.calls.filter((call) => call === "continueTeardown")).toHaveLength(2);
    expect(lifecycle.getState().progress).toEqual({ done: false, commentTotal: 250, commentsRemaining: 0 });

    lifecycle.detachPanel();
    expect(fake.signals.at(-1)?.aborted).toBe(true);
    heldBatch.resolve({ done: false, commentTotal: 250, commentsRemaining: 0 });
    await tick();
    expect(fake.calls.filter((call) => call === "continueTeardown")).toHaveLength(2);

    lifecycle.attachPanel();
    await tick();
    expect(fake.calls.filter((call) => call === "continueTeardown")).toHaveLength(3);
    expect(lifecycle.getState()).toMatchObject({
      panel: "ready",
      completeLink: null,
      progress: { done: true, commentTotal: 250, commentsRemaining: 0 },
    });
    expect(lifecycle.getState().state?.publication).toBeNull();
  });

  it("surfaces a failed teardown without auto-restarting, and resumes on retry", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const nextState = stateQueue([deletingState(), deletingState(), baseState()]);
    fake.handlers.loadState = async () => nextState();
    let attempts = 0;
    fake.handlers.continueTeardown = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("network lost");
      return { done: true, commentTotal: 4, commentsRemaining: 0 };
    };

    lifecycle.updateContext(context());
    lifecycle.attachPanel();
    await tick();
    expect(attempts).toBe(1);
    expect(lifecycle.getState().teardownFailed).toBe(true);
    expect(lifecycle.getState().state?.publication?.state).toBe("deleting");

    lifecycle.retryTeardown();
    await tick();
    expect(attempts).toBe(2);
    expect(lifecycle.getState().teardownFailed).toBe(false);
    expect(lifecycle.getState().state?.publication).toBeNull();
  });

  it("disposes on navigation so late results cannot update a new view", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const read = deferred<PublicationState>();
    fake.handlers.loadState = () => read.promise;

    lifecycle.updateContext(context());
    lifecycle.attachPanel();
    await tick();
    lifecycle.dispose();
    read.resolve(activeState("link-1"));
    await tick();

    expect(lifecycle.getState()).toMatchObject({ panel: "loading", state: null, completeLink: null });
    expect(await lifecycle.publish({ includeSelf: false, audience: "public" })).toBe(false);
    expect(fake.calls).toEqual(["loadState"]);
  });

  it("retains candidates across same-File revalidation and uses the current context", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const nextState = stateQueue([baseState(), activeState("link-1"), activeState("link-2")]);
    fake.handlers.loadState = async () => nextState();
    const first = linkFor("link-1", "one");
    const rotated = linkFor("link-2", "two");
    fake.handlers.publish = async (input) => {
      input.onPrepared(first);
    };
    fake.handlers.rotateLink = async (input) => {
      input.onPrepared(rotated);
    };

    const initial = context();
    lifecycle.updateContext(initial);
    lifecycle.attachPanel();
    await tick();
    expect(await lifecycle.publish({ includeSelf: false, audience: "public" })).toBe(true);
    expect(lifecycle.getState().completeLink).toBe(first.url);

    const refreshed = context({ access: { ...initial.access, actorAccountId: "account-2" } });
    lifecycle.updateContext(refreshed);
    expect(lifecycle.getState()).toMatchObject({ panel: "ready", completeLink: first.url });

    expect(await lifecycle.rotateLink()).toBe(true);
    expect(fake.contexts.at(-1)).toBe(refreshed);
    expect(lifecycle.getState().completeLink).toBe(rotated.url);
  });

  it("uses the retained candidate matching the active link, otherwise the typed link", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const nextState = stateQueue([baseState(), activeState("link-1")]);
    fake.handlers.loadState = async () => nextState();
    const retained = linkFor("link-1", "one");
    fake.handlers.publish = async (input) => {
      input.onPrepared(retained);
    };
    const changes: ChangeAudienceInput[] = [];
    fake.handlers.loadActivePublication = async () => ({
      publicationId: "pub-1",
      linkId: "link-1",
      publicKey: new Uint8Array(65),
    });
    fake.handlers.changeAudience = async (input) => {
      changes.push(input);
    };

    lifecycle.updateContext(context());
    lifecycle.attachPanel();
    await tick();
    expect(await lifecycle.publish({ includeSelf: false, audience: "public" })).toBe(true);

    expect(await lifecycle.changeAudience("collaborators_only", " https://mdwn.test/p/typed#v1.typed ")).toBe(true);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      audience: "collaborators_only",
      completeLink: retained.url,
      expectedEpochId: null,
      expectedThreadId: null,
    });
  });

  it("falls back to the typed complete link when no candidate matches", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const nextState = stateQueue([baseState(), activeState("link-2")]);
    fake.handlers.loadState = async () => nextState();
    fake.handlers.publish = async (input) => {
      input.onPrepared(linkFor("link-1", "one"));
    };
    const changes: ChangeAudienceInput[] = [];
    fake.handlers.loadActivePublication = async () => ({
      publicationId: "pub-1",
      linkId: "link-2",
      publicKey: new Uint8Array(65),
    });
    fake.handlers.changeAudience = async (input) => {
      changes.push(input);
    };

    lifecycle.updateContext(context());
    lifecycle.attachPanel();
    await tick();
    await lifecycle.publish({ includeSelf: false, audience: "public" });

    expect(await lifecycle.changeAudience("public", " https://mdwn.test/p/typed#v1.typed ")).toBe(true);
    expect(changes[0]?.completeLink).toBe("https://mdwn.test/p/typed#v1.typed");
  });

  it("rejects an audience change when the authoritative Publication identity changed", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const nextState = stateQueue([activeState("link-1"), activeState("link-1")]);
    fake.handlers.loadState = async () => nextState();
    fake.handlers.loadActivePublication = async () => ({
      publicationId: "pub-2",
      linkId: "link-1",
      publicKey: new Uint8Array(65),
    });

    lifecycle.updateContext(context());
    lifecycle.attachPanel();
    await tick();

    expect(await lifecycle.changeAudience("collaborators_only", "")).toBe(false);
    expect(fake.calls).not.toContain("changeAudience");
    expect(lifecycle.getState().error?.code).toBe("changed");
  });

  it("shares pending and error coordination across panel requests", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const nextState = stateQueue([baseState({ isOwner: false }), baseState({ isOwner: false })]);
    fake.handlers.loadState = async () => nextState();
    let busyDuringRequest = false;
    fake.handlers.requestPublication = async () => {
      busyDuringRequest = lifecycle.getState().busy;
      throw new PublicationError("limited");
    };

    lifecycle.updateContext(context());
    lifecycle.attachPanel();
    await tick();
    expect(await lifecycle.requestPublication()).toBe(false);
    expect(busyDuringRequest).toBe(true);
    expect(fake.calls).toEqual(["loadState", "requestPublication", "loadState"]);
    expect(lifecycle.getState()).toMatchObject({
      busy: false,
      error: { code: "limited", suspendedUntil: null },
    });
  });

  it("ignores a second decision while one is still pending", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const nextState = stateQueue([baseState({ isOwner: false }), baseState({ isOwner: false })]);
    fake.handlers.loadState = async () => nextState();
    const held = deferred<void>();
    fake.handlers.requestPublication = async () => {
      await held.promise;
    };

    lifecycle.updateContext(context());
    lifecycle.attachPanel();
    await tick();
    const first = lifecycle.requestPublication();
    await tick();
    expect(await lifecycle.requestPublication()).toBe(false);
    held.resolve();
    expect(await first).toBe(true);
    expect(fake.calls.filter((call) => call === "requestPublication")).toHaveLength(1);
  });

  it("credits a collaborator through the module's current Publication identity", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const nextState = stateQueue([activeState("link-1"), activeState("link-1")]);
    fake.handlers.loadState = async () => nextState();
    const credited: { publicationId: string; address: string }[] = [];
    fake.handlers.addAccountAuthor = async (input) => {
      credited.push(input);
    };

    lifecycle.updateContext(context());
    lifecycle.attachPanel();
    await tick();
    expect(await lifecycle.addAccountAuthor("collaborator")).toBe(true);
    expect(credited).toEqual([{ publicationId: "pub-1", address: "collaborator" }]);
    expect(fake.calls).toEqual(["loadState", "addAccountAuthor", "loadState"]);
  });

  it("waits for the page's first context before reading authoritative state", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const nextState = stateQueue([activeState("link-1")]);
    fake.handlers.loadState = async () => nextState();

    lifecycle.attachPanel();
    await tick();
    expect(fake.calls).toEqual([]);
    expect(lifecycle.getState().panel).toBe("loading");

    lifecycle.updateContext(context());
    await tick();
    expect(fake.calls).toEqual(["loadState"]);
    expect(lifecycle.getState().panel).toBe("ready");
  });

  it("re-reads authoritative state for a confirmation through the shared coordination", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const nextState = stateQueue([baseState({ commentCount: 3 }), baseState({ commentCount: 250 })]);
    fake.handlers.loadState = async () => nextState();

    lifecycle.updateContext(context());
    lifecycle.attachPanel();
    await tick();
    expect(lifecycle.getState().state?.commentCount).toBe(3);

    expect(await lifecycle.refresh()).toBe(true);
    expect(lifecycle.getState().state?.commentCount).toBe(250);
    expect(fake.calls).toEqual(["loadState", "loadState"]);
  });

  it("preserves a suspension's fixed automatic end", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const nextState = stateQueue([baseState({ isOwner: false }), baseState({ isOwner: false })]);
    fake.handlers.loadState = async () => nextState();
    fake.handlers.requestPublication = async () => {
      throw new PublicationError("suspended", 1_800_000_000_000);
    };

    lifecycle.updateContext(context());
    lifecycle.attachPanel();
    await tick();
    expect(await lifecycle.requestPublication()).toBe(false);
    expect(lifecycle.getState().error).toEqual({ code: "suspended", suspendedUntil: 1_800_000_000_000 });
  });
});
