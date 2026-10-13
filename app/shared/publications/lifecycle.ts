import type { RootAccess } from "~/shared/tree/client";

/**
 * Browser-only Publication lifecycle. One instance owns one File page's
 * prepared-link candidates, authoritative-state ordering, panel work and
 * Unpublishing teardown. UI callers forward the person's decisions and render
 * `getState()`; they never coordinate candidates, read generations or
 * teardown steps. Complete Public links stay in browser memory only: a
 * prepared candidate, or the one the Owner's browser opened from its Owner
 * link copy.
 */

export type CommentAudience = "public" | "collaborators_only";

/** How a File is published: what the publish form chooses. */
export type PublicationSettings = { audience: CommentAudience; includeSelf: boolean };

/** What the settings form chooses for a published File. A Publication from
 * before Public Comment threads existed has none: `audience: null` keeps it
 * without one, and choosing an audience sets one up. */
export type SettingsChange = Omit<PublicationSettings, "audience"> & { audience: CommentAudience | null };

/** Browser-memory-only material, never a route submission or server value. */
export type PreparedPublicLink = { publicationId: string; linkId: string; url: string };

export type PublicationState = {
  fileId: string;
  isOwner: boolean;
  canEdit: boolean;
  publication: null | {
    publicationId: string;
    state: "active" | "deleting";
    linkId?: string | null;
    /** Owner only: the complete link this browser opened from the active
     * link's Owner link copy, or null when the link has none or it does not
     * open here. Browser memory only, like a prepared candidate. */
    link?: string | null;
    createdAt: number;
    authors: { declarationId: string; ordinal: number; self: boolean; declared: boolean }[];
  };
  comments: { threadId: string; epochId: string; audience: CommentAudience } | null;
  commentCount: number;
  teardown: null | { commentTotal: number; commentsRemaining: number };
  requests: { requestId: string; own: boolean; createdAt: number }[];
};

/** Bounded teardown progress; `commentsRemaining` reaches zero one batch before
 * the final batch removes the rest of the public material. */
export type TeardownProgress = { done: boolean; commentTotal: number; commentsRemaining: number };

export type PublicationErrorCode =
  | "changed"
  | "exists"
  | "file-changed"
  | "limited"
  | "not-found"
  | "suspended"
  | "too-large"
  | "author-exists"
  | "author-limit"
  | "link-required"
  | "pseudonym-pending"
  | "rotation-required"
  | "unavailable";

/** A bounded, non-revealing failure the Publish panel can explain. A
 * Public-participation suspension carries only its fixed automatic end. */
export class PublicationError extends Error {
  constructor(
    readonly code: PublicationErrorCode,
    readonly suspendedUntil: number | null = null,
  ) {
    super(code);
  }
}

/** A settings step that failed after its new link had already committed. */
class AfterNewLink extends Error {
  constructor(readonly step: unknown) {
    super("after-new-link");
  }
}

/** The same-File access/context later operations use. Revalidation updates it
 * without ending the lifecycle, so retained candidates survive. */
export type PublicationContext = {
  fileId: string;
  access: RootAccess;
  parentId: string | null;
  parentKey: Uint8Array | null;
};

export type PublishInput = PublicationSettings & { onPrepared: (link: PreparedPublicLink) => void };

export type RotateLinkInput = { onPrepared: (link: PreparedPublicLink) => void };

export type ChangeAudienceInput = {
  audience: CommentAudience;
  /** Publication identity from the panel's authoritative state; a fresh read
   * that disagrees is a `changed` failure. */
  expectedPublicationId: string | null;
  expectedEpochId: string | null;
  threadId: string | null;
  /** Resolves the complete link for a fresh authoritative active link: the
   * retained candidate by identity, else the Owner link copy opened for that
   * same link. Matching and fallback ordering stay inside the lifecycle. */
  linkFor: (linkId: string | null) => string | null;
};

export type AddAccountAuthorInput = { publicationId: string; address: string };

export type RemoveAuthorInput = { declarationId: string };

export type RemovePublicationRequestInput = { requestId: string };

/**
 * The single internal operations seam. The production adapter wraps the
 * feature-local browser client; deterministic tests control responses here.
 * A `publish`/`rotateLink` implementation must call `onPrepared` before its
 * request can commit, and `changeAudience` must use the lifecycle's
 * `linkFor` resolver rather than matching candidates itself.
 */
export type PublicationOperations = {
  loadState(context: PublicationContext, signal: AbortSignal): Promise<PublicationState>;
  publish(context: PublicationContext, input: PublishInput, signal: AbortSignal): Promise<void>;
  rotateLink(context: PublicationContext, input: RotateLinkInput, signal: AbortSignal): Promise<void>;
  unpublish(context: PublicationContext, signal: AbortSignal): Promise<void>;
  continueTeardown(context: PublicationContext, signal: AbortSignal): Promise<TeardownProgress>;
  changeAudience(context: PublicationContext, input: ChangeAudienceInput, signal: AbortSignal): Promise<void>;
  addSelfAuthor(context: PublicationContext, signal: AbortSignal): Promise<void>;
  /** Re-declare the actor's existing author selection to the current link. */
  declareSelfAuthor(context: PublicationContext, signal: AbortSignal): Promise<void>;
  addAccountAuthor(context: PublicationContext, input: AddAccountAuthorInput, signal: AbortSignal): Promise<void>;
  removeAuthor(context: PublicationContext, input: RemoveAuthorInput, signal: AbortSignal): Promise<void>;
  requestPublication(context: PublicationContext, signal: AbortSignal): Promise<void>;
  removePublicationRequest(
    context: PublicationContext,
    input: RemovePublicationRequestInput,
    signal: AbortSignal,
  ): Promise<void>;
};

/** `newLinkCreated`: a settings change created its new link, then a later step failed. */
export type PublicationFailure = { code: PublicationErrorCode; suspendedUntil: number | null; newLinkCreated: boolean };

/** What the React adapter renders. Candidates, generations and teardown steps
 * stay inside the module. */
export type PublicationLifecycleState = {
  panel: "loading" | "failed" | "ready";
  state: PublicationState | null;
  /** The latest authoritative state this File page has read. Unlike `state`
   * it survives closing the panel, so the page can keep showing whether the
   * File is published. */
  latest: PublicationState | null;
  busy: boolean;
  error: PublicationFailure | null;
  progress: TeardownProgress | null;
  teardownFailed: boolean;
  /** True once this File page saw a sealed Publication and then an
   * authoritative read without it: the final transaction has committed,
   * whether this page or scheduled maintenance drove it. */
  deletionComplete: boolean;
  completeLink: string | null;
  /** True once the current context can run capability-bearing operations (its
   * parent key is available). */
  canOperate: boolean;
};

const initialView = (): PublicationLifecycleState => ({
  panel: "loading",
  state: null,
  latest: null,
  busy: false,
  error: null,
  progress: null,
  teardownFailed: false,
  deletionComplete: false,
  completeLink: null,
  canOperate: false,
});

function failure(error: unknown): PublicationFailure {
  if (error instanceof AfterNewLink) return { ...failure(error.step), newLinkCreated: true };
  return error instanceof PublicationError
    ? { code: error.code, suspendedUntil: error.suspendedUntil, newLinkCreated: false }
    : { code: "unavailable", suspendedUntil: null, newLinkCreated: false };
}

export class PublicationLifecycle {
  private view: PublicationLifecycleState = initialView();
  private context: PublicationContext | null = null;
  /** Retained until this File page ends, keyed by link identity so an earlier
   * winning candidate is never replaced by a later losing one. */
  private readonly candidates = new Map<string, PreparedPublicLink>();
  private readonly listeners = new Set<() => void>();
  private panelActive = false;
  private panelEpoch = 0;
  private readGeneration = 0;
  private teardownEpoch: number | null = null;
  private teardownRestart = false;
  /** The sealed Publication this File page last saw, kept across panel
   * reopenings so completion by scheduled maintenance is still recognised. */
  private sealedPublicationId: string | null = null;
  private controller: AbortController | null = null;
  private disposed = false;

  constructor(private readonly operations: PublicationOperations) {}

  getState = (): PublicationLifecycleState => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Successful same-File revalidation keeps the lifecycle; later operations
   * use the current access/context. */
  updateContext(context: PublicationContext): void {
    if (this.disposed) return;
    const firstContext = this.context === null;
    this.context = context;
    const canOperate = this.contextCanOperate();
    if (this.view.canOperate !== canOperate) this.set({ canOperate });
    // A panel can attach before the page supplies its first context (for
    // example a child effect that runs before the page's own effect).
    if (firstContext && this.panelActive && this.view.panel === "loading") void this.readState();
  }

  /** Opening the panel starts a fresh authoritative read and resumes teardown
   * while the Publication is still deleting. */
  attachPanel(): void {
    if (this.disposed) return;
    this.endPanelWork();
    this.panelActive = true;
    this.controller = new AbortController();
    // Resetting the panel view must not forget whether the current context can
    // operate, or what the page last read: both belong to the File page, not
    // the panel.
    this.set({ ...initialView(), latest: this.view.latest, canOperate: this.contextCanOperate() });
    void this.readState();
  }

  /** Closing the panel stops scheduling and aborts its cancellable work while
   * retained candidates and the latest state survive for the File page. */
  detachPanel(): void {
    this.panelActive = false;
    this.endPanelWork();
    // Page listeners read only `latest`, which this reset keeps; the next
    // attach starts the panel fresh.
    this.set({ ...initialView(), latest: this.view.latest }, { notify: false });
  }

  /** Another File, leaving the route or a full reload disposes the lifecycle;
   * late UI results can no longer be applied. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.panelActive = false;
    this.endPanelWork();
    this.candidates.clear();
    this.listeners.clear();
  }

  retryLoad(): void {
    if (this.disposed || !this.panelActive) return;
    // A fresh load may discover the Publication is still deleting, so it also
    // clears a failed teardown and lets the reload resume it.
    this.set({ panel: "loading", state: null, completeLink: null, error: null, progress: null, teardownFailed: false });
    void this.readState();
  }

  retryTeardown(): void {
    if (this.disposed || !this.panelActive) return;
    // A click can arrive while a failed loop is still reloading; remember the
    // request so the loop restarts as soon as it finishes.
    this.teardownRestart = true;
    this.set({ teardownFailed: false });
    this.maybeStartTeardown(true);
  }

  /** Re-read authoritative state through the shared coordination, for decisions
   * that must show the current opaque count (the Unpublish confirmation). */
  refresh(): Promise<boolean> {
    return this.run(async () => {});
  }

  publish(settings: PublicationSettings): Promise<boolean> {
    return this.run((context, signal) =>
      this.operations.publish(context, { ...settings, onPrepared: (link) => this.retain(link) }, signal),
    );
  }

  unpublish(): Promise<boolean> {
    return this.run((context, signal) => this.operations.unpublish(context, signal));
  }

  /**
   * The Owner changes how the File is published. Only what differs from the
   * panel's authoritative state is changed. With `newLink`, the current link
   * is retired first (its replacement is retained like any prepared candidate)
   * and the settings apply to the new link, so making Comments public never
   * needs a link this browser cannot show. A failure after the new link
   * committed says so: the person can finish with an in-place save instead
   * of retiring another link.
   */
  changeSettings(next: SettingsChange, options: { newLink: boolean }): Promise<boolean> {
    const state = this.view.state;
    const publication = state?.publication;
    if (!state || !publication || publication.state !== "active") return Promise.resolve(false);
    const self = publication.authors.find((author) => author.self) ?? null;
    return this.run(async (context, signal) => {
      if (options.newLink)
        await this.operations.rotateLink(context, { onPrepared: (link) => this.retain(link) }, signal);
      try {
        if (next.audience && next.audience !== state.comments?.audience)
          await this.operations.changeAudience(
            context,
            {
              audience: next.audience,
              expectedPublicationId: publication.publicationId,
              expectedEpochId: state.comments?.epochId ?? null,
              threadId: state.comments?.threadId ?? null,
              linkFor: (linkId) => this.linkFor(linkId, state),
            },
            signal,
          );
        if (next.includeSelf && !self) await this.operations.addSelfAuthor(context, signal);
        else if (!next.includeSelf && self)
          await this.operations.removeAuthor(context, { declarationId: self.declarationId }, signal);
        // A new link serves no declaration until its author re-declares to it;
        // the Owner's own device can do that at once.
        else if (self && options.newLink) await this.operations.declareSelfAuthor(context, signal);
      } catch (error) {
        throw options.newLink ? new AfterNewLink(error) : error;
      }
    });
  }

  /** Person decisions for Collaborator credits and Publication requests. Every
   * one shares the same pending/error/refresh coordination as the
   * lifecycle-owned requests, and their business rules stay in the operations
   * seam. */
  addAccountAuthor(address: string): Promise<boolean> {
    const publicationId = this.view.state?.publication?.publicationId;
    if (!publicationId) return Promise.resolve(false);
    return this.run((context, signal) => this.operations.addAccountAuthor(context, { publicationId, address }, signal));
  }

  removeAuthor(declarationId: string): Promise<boolean> {
    return this.run((context, signal) => this.operations.removeAuthor(context, { declarationId }, signal));
  }

  requestPublication(): Promise<boolean> {
    return this.run((context, signal) => this.operations.requestPublication(context, signal));
  }

  removePublicationRequest(requestId: string): Promise<boolean> {
    return this.run((context, signal) => this.operations.removePublicationRequest(context, { requestId }, signal));
  }

  /** Shared pending/error/refresh coordination for every panel mutation. */
  private async run(action: (context: PublicationContext, signal: AbortSignal) => Promise<void>): Promise<boolean> {
    const context = this.context;
    const controller = this.controller;
    if (this.disposed || !this.panelActive || !context || !controller || controller.signal.aborted) return false;
    if (this.view.busy) return false;
    const epoch = this.panelEpoch;
    this.set({ busy: true, error: null });
    let ok = true;
    try {
      await action(context, controller.signal);
    } catch (error) {
      ok = false;
      if (this.isActive(epoch, controller)) this.set({ error: failure(error) });
    }
    if (!this.isActive(epoch, controller)) return false;
    await this.readState();
    if (this.isActive(epoch, controller)) this.set({ busy: false });
    return ok && this.isActive(epoch, controller);
  }

  /** Last-issued read wins: an overlapping refresh can never replace a newer
   * state (for example the post-unpublish read) with a stale active panel. */
  private async readState(options: { resumeTeardown: boolean } = { resumeTeardown: true }): Promise<void> {
    const context = this.context;
    const controller = this.controller;
    if (this.disposed || !this.panelActive || !context || !controller || controller.signal.aborted) return;
    const epoch = this.panelEpoch;
    const generation = ++this.readGeneration;
    try {
      const state = await this.operations.loadState(context, controller.signal);
      if (!this.isActive(epoch, controller) || generation !== this.readGeneration) return;
      const deleting = state.isOwner && state.publication?.state === "deleting";
      // Only the final teardown transaction removes the sealed row; a later
      // Publication of the File is a different, live one.
      if (state.publication) {
        this.sealedPublicationId = state.publication.state === "deleting" ? state.publication.publicationId : null;
      }
      this.set({
        panel: "ready",
        state,
        latest: state,
        completeLink: this.completeLink(state),
        deletionComplete: state.publication === null && this.sealedPublicationId !== null,
        ...(deleting ? {} : { teardownFailed: false }),
      });
      if (deleting) this.maybeStartTeardown(options.resumeTeardown);
    } catch {
      if (!this.isActive(epoch, controller) || generation !== this.readGeneration) return;
      this.set({ panel: "failed", state: null, completeLink: null });
    }
  }

  /** The displayed complete link matches the authoritative active-link
   * identity; a failed or superseded candidate is never presented. */
  private completeLink(state: PublicationState): string | null {
    return this.linkFor(state.publication?.linkId, state);
  }

  /** The complete link for one authoritative active-link identity: a retained
   * candidate, else the Owner link copy `state` opened for that same link.
   * Only exact identity matches are usable. */
  private linkFor(linkId: string | null | undefined, state: PublicationState): string | null {
    if (!linkId) return null;
    const retained = this.candidates.get(linkId)?.url;
    if (retained) return retained;
    const publication = state.publication;
    return publication?.state === "active" && publication.linkId === linkId ? (publication.link ?? null) : null;
  }

  /** Retain every prepared candidate immediately; the request that follows may
   * commit even when its response is lost. */
  private retain(link: PreparedPublicLink): void {
    if (this.disposed) return;
    this.candidates.set(link.linkId, link);
    const state = this.view.state;
    if (state) this.set({ completeLink: this.completeLink(state) });
  }

  private maybeStartTeardown(resume: boolean): void {
    if (!resume || this.view.teardownFailed) return;
    const context = this.context;
    const controller = this.controller;
    const state = this.view.state;
    if (!context || !controller || !this.panelActive || !state) return;
    if (!state.isOwner || state.publication?.state !== "deleting") return;
    if (this.teardownEpoch === this.panelEpoch) return;
    this.teardownEpoch = this.panelEpoch;
    this.teardownRestart = false;
    void this.driveTeardown(context, controller, this.panelEpoch);
  }

  /** Idempotent bounded batches until the existing protocol reports final
   * completion; zero remaining Comments is not completion. */
  private async driveTeardown(context: PublicationContext, controller: AbortController, epoch: number): Promise<void> {
    try {
      let progress = await this.operations.continueTeardown(context, controller.signal);
      while (this.isActive(epoch, controller) && !progress.done) {
        this.set({ progress });
        progress = await this.operations.continueTeardown(context, controller.signal);
      }
      if (!this.isActive(epoch, controller)) return;
      this.set({ progress });
      await this.readState({ resumeTeardown: false });
    } catch {
      if (!this.isActive(epoch, controller)) return;
      this.set({ teardownFailed: true });
      await this.readState({ resumeTeardown: false });
    } finally {
      if (this.teardownEpoch === epoch) {
        this.teardownEpoch = null;
        if (this.teardownRestart) {
          this.teardownRestart = false;
          this.maybeStartTeardown(true);
        }
      }
    }
  }

  private contextCanOperate(): boolean {
    return this.context !== null && this.context.parentKey !== null;
  }

  private isActive(epoch: number, controller: AbortController): boolean {
    return !this.disposed && this.panelActive && epoch === this.panelEpoch && !controller.signal.aborted;
  }

  /** Invalidates the current panel epoch and aborts its cancellable work. */
  private endPanelWork(): void {
    this.panelEpoch += 1;
    this.readGeneration += 1;
    this.teardownEpoch = null;
    this.teardownRestart = false;
    this.controller?.abort();
    this.controller = null;
  }

  private set(update: Partial<PublicationLifecycleState>, options: { notify?: boolean } = {}): void {
    this.view = { ...this.view, ...update };
    if (options.notify ?? true) for (const listener of this.listeners) listener();
  }
}
