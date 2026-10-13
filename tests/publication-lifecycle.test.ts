import { describe, expect, it } from "vitest";

import {
  PublicationError,
  PublicationLifecycle,
  type AddAccountAuthorInput,
  type ChangeAudienceInput,
  type PreparedPublicLink,
  type PublicationContext,
  type PublicationOperations,
  type PublicationState,
  type PublishInput,
  type RemoveAuthorInput,
  type RemovePublicationRequestInput,
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

const activeState = (
  linkId: string,
  overrides: Partial<NonNullable<PublicationState["publication"]>> = {},
  state: Partial<PublicationState> = {},
): PublicationState =>
  baseState({
    publication: { publicationId: "pub-1", state: "active", linkId, createdAt: 1, authors: [], ...overrides },
    ...state,
  });

const publicComments = { threadId: "thread-1", epochId: "epoch-1", audience: "public" as const };
const closedComments = { threadId: "thread-1", epochId: "epoch-1", audience: "collaborators_only" as const };
const selfAuthor = { declarationId: "declaration-self", ordinal: 1, self: true, declared: true };

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
  const audienceInputs: ChangeAudienceInput[] = [];
  const authorRemovals: RemoveAuthorInput[] = [];
  const record = (method: string, context: PublicationContext, signal: AbortSignal) => {
    calls.push(method);
    contexts.push(context);
    signals.push(signal);
  };
  const handlers = {
    loadState: async (_signal: AbortSignal): Promise<PublicationState> => {
      throw new Error("unexpected loadState");
    },
    publish: async (_input: PublishInput, _signal: AbortSignal): Promise<void> => {},
    rotateLink: async (_input: RotateLinkInput, _signal: AbortSignal): Promise<void> => {},
    unpublish: async (_signal: AbortSignal): Promise<void> => {},
    continueTeardown: async (_signal: AbortSignal): Promise<TeardownProgress> => ({
      done: true,
      commentTotal: 0,
      commentsRemaining: 0,
    }),
    changeAudience: async (_input: ChangeAudienceInput, _signal: AbortSignal): Promise<void> => {},
    addSelfAuthor: async (_signal: AbortSignal): Promise<void> => {},
    declareSelfAuthor: async (_signal: AbortSignal): Promise<void> => {},
    addAccountAuthor: async (_input: AddAccountAuthorInput, _signal: AbortSignal): Promise<void> => {},
    removeAuthor: async (_input: RemoveAuthorInput, _signal: AbortSignal): Promise<void> => {},
    requestPublication: async (_signal: AbortSignal): Promise<void> => {},
    removePublicationRequest: async (_input: RemovePublicationRequestInput, _signal: AbortSignal): Promise<void> => {},
  };
  const operations: PublicationOperations = {
    loadState: (context, signal) => {
      record("loadState", context, signal);
      return handlers.loadState(signal);
    },
    publish: (context, input, signal) => {
      record("publish", context, signal);
      return handlers.publish(input, signal);
    },
    rotateLink: (context, input, signal) => {
      record("rotateLink", context, signal);
      return handlers.rotateLink(input, signal);
    },
    unpublish: (context, signal) => {
      record("unpublish", context, signal);
      return handlers.unpublish(signal);
    },
    continueTeardown: (context, signal) => {
      record("continueTeardown", context, signal);
      return handlers.continueTeardown(signal);
    },
    changeAudience: (context, input, signal) => {
      record("changeAudience", context, signal);
      audienceInputs.push(input);
      return handlers.changeAudience(input, signal);
    },
    addSelfAuthor: (context, signal) => {
      record("addSelfAuthor", context, signal);
      return handlers.addSelfAuthor(signal);
    },
    declareSelfAuthor: (context, signal) => {
      record("declareSelfAuthor", context, signal);
      return handlers.declareSelfAuthor(signal);
    },
    addAccountAuthor: (context, input, signal) => {
      record("addAccountAuthor", context, signal);
      return handlers.addAccountAuthor(input, signal);
    },
    removeAuthor: (context, input, signal) => {
      record("removeAuthor", context, signal);
      authorRemovals.push(input);
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
  };
  return { operations, handlers, calls, contexts, signals, audienceInputs, authorRemovals };
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

  it("resolves the retained complete link for the fresh authoritative active link on an audience change", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const nextState = stateQueue([activeState("link-1"), activeState("link-1"), activeState("link-1")]);
    fake.handlers.loadState = async () => nextState();
    const link = linkFor("link-1", "one");
    fake.handlers.publish = async (input) => {
      input.onPrepared(link);
    };

    lifecycle.updateContext(context());
    lifecycle.attachPanel();
    await tick();
    await lifecycle.publish({ includeSelf: false, audience: "public" });

    expect(
      await lifecycle.changeSettings({ audience: "collaborators_only", includeSelf: false }, { newLink: false }),
    ).toBe(true);
    const seen = fake.audienceInputs.at(-1)!;
    expect(seen).toMatchObject({
      audience: "collaborators_only",
      expectedPublicationId: "pub-1",
      expectedEpochId: null,
      threadId: null,
    });
    expect(seen.linkFor("link-1")).toBe(link.url);
    expect(seen.linkFor("link-2")).toBeNull();
    expect(seen.linkFor(null)).toBeNull();
    expect(fake.calls).toEqual(["loadState", "publish", "loadState", "changeAudience", "loadState"]);
  });

  it("refreshes authority after every successful panel mutation", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const nextState = stateQueue([
      activeState("link-1"),
      activeState("link-1"),
      activeState("link-1"),
      activeState("link-1"),
      activeState("link-1"),
      activeState("link-1"),
    ]);
    fake.handlers.loadState = async () => nextState();

    lifecycle.updateContext(context());
    lifecycle.attachPanel();
    await tick();
    expect(await lifecycle.changeSettings({ audience: "public", includeSelf: true }, { newLink: false })).toBe(true);
    expect(await lifecycle.addAccountAuthor("Member")).toBe(true);
    expect(await lifecycle.removeAuthor("declaration-1")).toBe(true);
    expect(await lifecycle.removePublicationRequest("request-1")).toBe(true);
    expect(await lifecycle.requestPublication()).toBe(true);

    expect(fake.calls).toEqual([
      "loadState",
      "changeAudience",
      "addSelfAuthor",
      "loadState",
      "addAccountAuthor",
      "loadState",
      "removeAuthor",
      "loadState",
      "removePublicationRequest",
      "loadState",
      "requestPublication",
      "loadState",
    ]);
  });

  it("shows the Owner link copy only for the authoritative active link", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const stored = linkFor("link-1", "stored").url;
    const nextState = stateQueue([activeState("link-1", { link: stored }), activeState("link-2", { link: null })]);
    fake.handlers.loadState = async () => nextState();

    lifecycle.updateContext(context());
    lifecycle.attachPanel();
    await tick();
    expect(lifecycle.getState().completeLink).toBe(stored);

    // A replaced link with no copy shows nothing, never the old link's copy.
    expect(await lifecycle.refresh()).toBe(true);
    expect(lifecycle.getState().completeLink).toBeNull();
  });

  it("makes Comments public in place with the Owner link copy, changing only what differs", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const stored = linkFor("link-1", "stored").url;
    const closed = activeState("link-1", { link: stored, authors: [selfAuthor] }, { comments: closedComments });
    const nextState = stateQueue([closed, closed, closed]);
    fake.handlers.loadState = async () => nextState();

    lifecycle.updateContext(context());
    lifecycle.attachPanel();
    await tick();
    expect(await lifecycle.changeSettings({ audience: "public", includeSelf: true }, { newLink: false })).toBe(true);
    const seen = fake.audienceInputs.at(-1)!;
    expect(seen).toMatchObject({ audience: "public", expectedEpochId: "epoch-1", threadId: "thread-1" });
    expect(seen.linkFor("link-1")).toBe(stored);
    expect(seen.linkFor("link-2")).toBeNull();
    expect(fake.calls).toEqual(["loadState", "changeAudience", "loadState"]);

    expect(
      await lifecycle.changeSettings({ audience: "collaborators_only", includeSelf: false }, { newLink: false }),
    ).toBe(true);
    expect(fake.authorRemovals).toEqual([{ declarationId: "declaration-self" }]);
    expect(fake.calls.slice(3)).toEqual(["removeAuthor", "loadState"]);
  });

  it("creates the new link first and applies the settings to it", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const rotated = linkFor("link-2", "two");
    const nextState = stateQueue([
      activeState("link-1", { link: null, authors: [selfAuthor] }, { comments: closedComments }),
      activeState("link-2", { link: null, authors: [selfAuthor] }, { comments: publicComments }),
    ]);
    fake.handlers.loadState = async () => nextState();
    fake.handlers.rotateLink = async (input) => {
      input.onPrepared(rotated);
    };

    lifecycle.updateContext(context());
    lifecycle.attachPanel();
    await tick();
    expect(lifecycle.getState().completeLink).toBeNull();
    expect(await lifecycle.changeSettings({ audience: "public", includeSelf: true }, { newLink: true })).toBe(true);
    // The public epoch is sealed with the new link's capability, and the
    // Owner's own declaration is renewed for the new link.
    expect(fake.audienceInputs.at(-1)!.linkFor("link-2")).toBe(rotated.url);
    expect(fake.calls).toEqual(["loadState", "rotateLink", "changeAudience", "declareSelfAuthor", "loadState"]);
    expect(lifecycle.getState()).toMatchObject({ completeLink: rotated.url, error: null });
  });

  it("says when a settings step failed after its new link committed", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const rotated = linkFor("link-2", "two");
    const nextState = stateQueue([
      activeState("link-1", {}, { comments: publicComments }),
      activeState("link-2", {}, { comments: publicComments }),
      activeState("link-2", {}, { comments: publicComments }),
    ]);
    fake.handlers.loadState = async () => nextState();
    fake.handlers.rotateLink = async (input) => {
      input.onPrepared(rotated);
    };
    fake.handlers.addSelfAuthor = async () => {
      throw new PublicationError("pseudonym-pending");
    };

    lifecycle.updateContext(context());
    lifecycle.attachPanel();
    await tick();
    expect(await lifecycle.changeSettings({ audience: "public", includeSelf: true }, { newLink: true })).toBe(false);
    expect(lifecycle.getState()).toMatchObject({
      completeLink: rotated.url,
      error: { code: "pseudonym-pending", newLinkCreated: true },
    });

    // A rotation that fails is not a partial change.
    fake.handlers.rotateLink = async () => {
      throw new PublicationError("limited");
    };
    expect(await lifecycle.changeSettings({ audience: "public", includeSelf: false }, { newLink: true })).toBe(false);
    expect(lifecycle.getState().error).toEqual({ code: "limited", suspendedUntil: null, newLinkCreated: false });
  });

  it("sets up no Public thread for a Publication without one unless an audience is chosen", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const nextState = stateQueue([activeState("link-1"), activeState("link-2"), activeState("link-2")]);
    fake.handlers.loadState = async () => nextState();
    fake.handlers.rotateLink = async (input) => {
      input.onPrepared(linkFor("link-2", "two"));
    };

    lifecycle.updateContext(context());
    lifecycle.attachPanel();
    await tick();
    expect(lifecycle.getState().state?.comments).toBeNull();
    expect(await lifecycle.changeSettings({ audience: null, includeSelf: false }, { newLink: true })).toBe(true);
    expect(fake.calls).toEqual(["loadState", "rotateLink", "loadState"]);

    expect(
      await lifecycle.changeSettings({ audience: "collaborators_only", includeSelf: false }, { newLink: false }),
    ).toBe(true);
    expect(fake.audienceInputs.at(-1)).toMatchObject({ audience: "collaborators_only", threadId: null });
  });

  it("keeps the latest authoritative state for the File page while the panel is closed", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const published = activeState("link-1");
    const nextState = stateQueue([published, baseState()]);
    fake.handlers.loadState = async () => nextState();

    lifecycle.updateContext(context());
    expect(lifecycle.getState().latest).toBeNull();
    lifecycle.attachPanel();
    await tick();
    lifecycle.detachPanel();
    expect(lifecycle.getState()).toMatchObject({ panel: "loading", state: null, latest: published });

    lifecycle.attachPanel();
    expect(lifecycle.getState()).toMatchObject({ state: null, latest: published });
    await tick();
    expect(lifecycle.getState().latest).toEqual(baseState());
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

  it("reports completed deletion only after observing the sealed Publication disappear", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    // This page stopped driving teardown; scheduled maintenance finishes it.
    const nextState = stateQueue([deletingState(), deletingState(), baseState(), activeState("link-2")]);
    fake.handlers.loadState = async () => nextState();
    fake.handlers.continueTeardown = async () => {
      throw new Error("network lost");
    };

    lifecycle.updateContext(context());
    lifecycle.attachPanel();
    await tick();
    expect(lifecycle.getState()).toMatchObject({ teardownFailed: true, deletionComplete: false });
    expect(lifecycle.getState().state?.publication?.state).toBe("deleting");

    lifecycle.detachPanel();
    lifecycle.attachPanel();
    await tick();
    expect(lifecycle.getState().state?.publication).toBeNull();
    expect(lifecycle.getState().deletionComplete).toBe(true);

    // A later Publication is not the deleted one.
    await lifecycle.refresh();
    expect(lifecycle.getState().deletionComplete).toBe(false);
  });

  it("never reports completed deletion for a File it never saw sealed", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    fake.handlers.loadState = async () => baseState();
    lifecycle.updateContext(context());
    lifecycle.attachPanel();
    await tick();
    expect(lifecycle.getState()).toMatchObject({ panel: "ready", deletionComplete: false });
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

  it("restarts teardown when retry arrives while the failure reload is in flight", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const failedReload = deferred<PublicationState>();
    let reads = 0;
    fake.handlers.loadState = async () => {
      reads += 1;
      if (reads === 1) return deletingState();
      if (reads === 2) return failedReload.promise;
      return baseState();
    };
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

    lifecycle.retryTeardown();
    failedReload.resolve(deletingState());
    await tick();
    expect(attempts).toBe(2);
    expect(lifecycle.getState().state?.publication).toBeNull();
  });

  it("retries a failed load and resumes teardown", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const nextState = stateQueue([deletingState(), deletingState(), baseState()]);
    let reads = 0;
    fake.handlers.loadState = async () => {
      reads += 1;
      if (reads === 2) throw new Error("load failed");
      return nextState();
    };
    let attempts = 0;
    fake.handlers.continueTeardown = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("network lost");
      return { done: true, commentTotal: 4, commentsRemaining: 0 };
    };

    lifecycle.updateContext(context());
    lifecycle.attachPanel();
    await tick();
    expect(lifecycle.getState().panel).toBe("failed");
    expect(lifecycle.getState().teardownFailed).toBe(true);

    lifecycle.retryLoad();
    await tick();
    expect(attempts).toBe(2);
    expect(lifecycle.getState()).toMatchObject({ panel: "ready", teardownFailed: false });
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
    const nextState = stateQueue([
      baseState(),
      activeState("link-1", {}, { comments: publicComments }),
      activeState("link-2", {}, { comments: publicComments }),
    ]);
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

    expect(await lifecycle.changeSettings({ audience: "public", includeSelf: false }, { newLink: true })).toBe(true);
    expect(fake.contexts.at(-1)).toBe(refreshed);
    expect(lifecycle.getState().completeLink).toBe(rotated.url);
  });

  it("shares pending and error coordination across module operations", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const nextState = stateQueue([activeState("link-1"), activeState("link-1")]);
    fake.handlers.loadState = async () => nextState();
    let busyDuringRequest = false;
    fake.handlers.rotateLink = async () => {
      busyDuringRequest = lifecycle.getState().busy;
      throw new PublicationError("rotation-required");
    };

    lifecycle.updateContext(context());
    lifecycle.attachPanel();
    await tick();
    expect(await lifecycle.changeSettings({ audience: "public", includeSelf: false }, { newLink: true })).toBe(false);
    expect(busyDuringRequest).toBe(true);
    expect(fake.calls).toEqual(["loadState", "rotateLink", "loadState"]);
    expect(lifecycle.getState()).toMatchObject({
      busy: false,
      error: { code: "rotation-required", suspendedUntil: null, newLinkCreated: false },
    });
  });

  it("shares pending, error and refresh across panel mutations", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const nextState = stateQueue([activeState("link-1"), activeState("link-1"), activeState("link-1")]);
    fake.handlers.loadState = async () => nextState();
    let busyDuringRequest = false;
    fake.handlers.addAccountAuthor = async () => {
      busyDuringRequest = lifecycle.getState().busy;
      throw new PublicationError("author-limit");
    };

    lifecycle.updateContext(context());
    lifecycle.attachPanel();
    await tick();
    expect(await lifecycle.addAccountAuthor("Member")).toBe(false);
    expect(busyDuringRequest).toBe(true);
    expect(fake.calls).toEqual(["loadState", "addAccountAuthor", "loadState"]);
    expect(lifecycle.getState()).toMatchObject({ busy: false, error: { code: "author-limit" } });

    fake.handlers.removeAuthor = async () => {};
    expect(await lifecycle.removeAuthor("declaration-1")).toBe(true);
    expect(lifecycle.getState().error).toBeNull();
    expect(fake.calls).toEqual(["loadState", "addAccountAuthor", "loadState", "removeAuthor", "loadState"]);
  });

  it("ignores a second module decision while one is still pending", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const live = activeState("link-1", {}, { comments: publicComments });
    const nextState = stateQueue([live, activeState("link-2", {}, { comments: publicComments })]);
    fake.handlers.loadState = async () => nextState();
    const held = deferred<void>();
    fake.handlers.rotateLink = async (input) => {
      input.onPrepared(linkFor("link-2", "two"));
      await held.promise;
    };
    const settings = { audience: "public", includeSelf: false } as const;

    lifecycle.updateContext(context());
    lifecycle.attachPanel();
    await tick();
    const first = lifecycle.changeSettings(settings, { newLink: true });
    await tick();
    expect(await lifecycle.changeSettings(settings, { newLink: true })).toBe(false);
    held.resolve();
    expect(await first).toBe(true);
    expect(fake.calls.filter((call) => call === "rotateLink")).toHaveLength(1);
  });

  it("preserves a suspension's fixed automatic end", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const nextState = stateQueue([baseState(), baseState()]);
    fake.handlers.loadState = async () => nextState();
    fake.handlers.publish = async () => {
      throw new PublicationError("suspended", 1_800_000_000_000);
    };

    lifecycle.updateContext(context());
    lifecycle.attachPanel();
    await tick();
    expect(await lifecycle.publish({ includeSelf: false, audience: "public" })).toBe(false);
    expect(lifecycle.getState().error).toEqual({
      code: "suspended",
      suspendedUntil: 1_800_000_000_000,
      newLinkCreated: false,
    });
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

  it("keeps the current context's capability readiness across a panel attach", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const nextState = stateQueue([baseState()]);
    fake.handlers.loadState = async () => nextState();

    lifecycle.updateContext(context());
    expect(lifecycle.getState().canOperate).toBe(true);

    lifecycle.attachPanel();
    await tick();
    expect(lifecycle.getState()).toMatchObject({ panel: "ready", canOperate: true });

    lifecycle.updateContext(context({ parentKey: null }));
    expect(lifecycle.getState().canOperate).toBe(false);
  });

  it("refuses a second panel mutation while one is pending", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const nextState = stateQueue([activeState("link-1"), activeState("link-1")]);
    fake.handlers.loadState = async () => nextState();
    const held = deferred<void>();
    fake.handlers.removeAuthor = async () => {
      await held.promise;
    };

    lifecycle.updateContext(context());
    lifecycle.attachPanel();
    await tick();
    const pending = lifecycle.removeAuthor("declaration-1");
    await tick();
    expect(lifecycle.getState().busy).toBe(true);
    expect(await lifecycle.requestPublication()).toBe(false);
    held.resolve();
    expect(await pending).toBe(true);
    expect(fake.calls.filter((call) => call === "requestPublication")).toHaveLength(0);
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

  it("ignores late panel-mutation results from a disposed lifecycle", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const lateRefresh = deferred<PublicationState>();
    let reads = 0;
    fake.handlers.loadState = async () => {
      reads += 1;
      return reads === 1 ? activeState("link-1") : lateRefresh.promise;
    };
    fake.handlers.requestPublication = async () => {};

    lifecycle.updateContext(context());
    lifecycle.attachPanel();
    await tick();
    const pending = lifecycle.requestPublication();
    await tick();
    lifecycle.dispose();
    lateRefresh.resolve(baseState({ commentCount: 250 }));

    expect(await pending).toBe(false);
    expect(lifecycle.getState()).toMatchObject({ state: { commentCount: 0 }, error: null });
    expect(fake.calls.filter((call) => call === "requestPublication")).toHaveLength(1);
  });

  it("does not let a failed panel mutation's superseded refresh replace newer state", async () => {
    const fake = fakeOperations();
    const lifecycle = new PublicationLifecycle(fake.operations);
    const failedRefresh = deferred<PublicationState>();
    let reads = 0;
    fake.handlers.loadState = async () => {
      reads += 1;
      if (reads === 1) return activeState("link-1");
      if (reads === 2) return failedRefresh.promise;
      return baseState({ commentCount: 250 });
    };
    fake.handlers.removeAuthor = async () => {
      throw new PublicationError("changed");
    };

    lifecycle.updateContext(context());
    lifecycle.attachPanel();
    await tick();
    const pending = lifecycle.removeAuthor("declaration-1");
    await tick();

    lifecycle.detachPanel();
    lifecycle.attachPanel();
    await tick();
    expect(lifecycle.getState().state?.commentCount).toBe(250);

    failedRefresh.resolve(activeState("link-1"));
    expect(await pending).toBe(false);
    expect(lifecycle.getState()).toMatchObject({ state: { commentCount: 250 }, error: null });
  });
});
