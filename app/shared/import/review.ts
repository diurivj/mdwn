/**
 * Import collision review (ticket 29).
 *
 * Pure, browser-local planning over one normalized `ImportSource` and one
 * decrypted Import target. It applies the locked `mdwn/namespace-v1` rules:
 * explicit sibling names are reserved before generated ones, Keep-both
 * candidates are found with the deterministic ` (n)` suffix in bytewise
 * source-path order, Directories never silently merge, and a generated name
 * that would exceed the 255-byte segment profile is never truncated — it
 * requires Rename, Skip, or an authorized File Replace.
 *
 * The review contains private display names and stays in this browser. It
 * creates no session and performs no upload.
 */

import { canonicalizeSegment, keepBothCandidate, NamespaceError, type CanonicalSegment } from "~/shared/namespace-v1";
import { ImportError } from "./limits";
import { compareUtf8, foldedToken, type ImportSource, type ImportSourceChild } from "./source";

export type ImportCollisionSibling = { nodeId: string; kind: "file" | "directory"; name: string };

/** One current sealed sibling edge, exactly as the decrypted listing returned it. */
export type ImportListingEntry = {
  nodeId: string;
  kind: "file" | "directory";
  nameCiphertext: string;
  orderCiphertext: string;
  keyEnvelope: string;
};

export type ImportTarget = {
  directoryId: string;
  keyEpoch: number;
  entriesRevision: number;
  /** The target Directory Owner; new nodes belong to this Account. */
  ownerAccountId: string;
  /** The importing Account. */
  actorAccountId: string;
  /** Browser-local display path for the review. */
  label: string;
  /** Decrypted current siblings, exactly as the target listing returned them. */
  siblings: readonly ImportCollisionSibling[];
  /** The same siblings' sealed edges, needed to sign the post-Import listing head. */
  listing: readonly ImportListingEntry[];
};

export type ImportChoice =
  | { action: "keep_both" }
  | { action: "skip" }
  | { action: "replace" }
  | { action: "rename"; name: string };

export type ImportChoices = Readonly<Record<string, ImportChoice>>;

export type ImportBlockedReason =
  | "parent_skipped"
  | "parent_blocked"
  | "invalid_name"
  | "name_in_use"
  | "cannot_replace"
  | "over_limit";

export type ImportReviewNode = {
  sourcePath: string;
  kind: "file" | "directory";
  parentSourcePath: string | null;
  requestedName: string;
  displayName: string;
  displayPath: string[];
  sourceBytes: number;
  action: "create" | "replace" | "skip";
  generated: boolean;
  collision: null | {
    existingNodeId: string;
    existingKind: "file" | "directory";
    existingName: string;
    sameSpelling: boolean;
  };
  /** The existing File this candidate would replace, when `action` is `replace`. */
  existingNodeId: string | null;
  choice: ImportChoice | null;
  blocked: ImportBlockedReason | null;
  children: ImportReviewNode[];
};

export type ImportReviewCounts = {
  sources: number;
  createFiles: number;
  createDirectories: number;
  replaces: number;
  skips: number;
  maxDepth: number;
  compressedBytes: number | null;
  expandedBytes: number;
  comments: number;
};

export type ImportReview = {
  status: "ok" | "blocked";
  target: ImportTarget;
  /** Synthetic target-root node; its `children` are the top-level candidates. */
  tree: ImportReviewNode;
  /** Every candidate, pre-order, excluding the synthetic root. */
  nodes: readonly ImportReviewNode[];
  counts: ImportReviewCounts;
  /** Display paths of every candidate that received a generated Keep-both name. */
  generatedNames: readonly string[];
  blocked: readonly ImportReviewNode[];
  /** `counts`-wise nothing would be created (every candidate skipped or replaced away). */
  empty: boolean;
  canConfirm: boolean;
};

function token(segment: string): string {
  return foldedToken(segment);
}

function pathToken(path: string): string {
  return path.split("/").map(token).join("/");
}

function compareSourcePaths(a: string, b: string): number {
  return compareUtf8(a, b);
}

function makeNode(child: ImportSourceChild, parent: ImportReviewNode): ImportReviewNode {
  const node: ImportReviewNode = {
    sourcePath: child.path.join("/"),
    kind: child.kind,
    parentSourcePath: parent.sourcePath === "" ? null : parent.sourcePath,
    requestedName: child.name,
    displayName: child.name,
    displayPath: [...parent.displayPath, child.name],
    sourceBytes: child.kind === "file" ? child.bytes : 0,
    action: "create",
    generated: false,
    collision: null,
    existingNodeId: null,
    choice: null,
    blocked: null,
    children: [],
  };
  if (child.kind === "directory")
    for (const grandchild of child.children) node.children.push(makeNode(grandchild, node));
  return node;
}

function skipSubtree(node: ImportReviewNode): void {
  node.action = "skip";
  node.blocked = node.blocked ?? "parent_skipped";
  for (const child of node.children) skipSubtree(child);
}

function canonicalRename(name: string): string | null {
  try {
    return canonicalizeSegment(name).display;
  } catch (error) {
    if (error instanceof NamespaceError) return null;
    throw error;
  }
}

/**
 * Reserve every explicit name first, then allocate generated Keep-both names
 * in bytewise source-path order. This implements the locked reservation, sort,
 * suffix, and availability rule with the vendored `keepBothCandidate` and
 * `comparisonKey` helpers; it is not a call to `allocateKeepBothNames` because
 * per-candidate Skip/Replace/Rename choices and over-limit blocking interleave
 * with allocation (ticket 25 requires the blocked outcome, not a thrown abort).
 * Children of newly created Directories have no existing siblings and are
 * allocated recursively.
 */
function allocateDirectory(node: ImportReviewNode, existingTokens: ReadonlyMap<string, ImportCollisionSibling>): void {
  const used = new Set<string>(existingTokens.keys());
  const ordered = node.children
    .slice()
    .sort(
      (a, b) => compareSourcePaths(a.sourcePath, b.sourcePath) || compareSourcePaths(a.requestedName, b.requestedName),
    );
  const pendingGenerated: ImportReviewNode[] = [];

  for (const child of ordered) {
    const collision = existingTokens.get(token(child.requestedName)) ?? null;
    child.collision = collision
      ? {
          existingNodeId: collision.nodeId,
          existingKind: collision.kind,
          existingName: collision.name,
          sameSpelling: collision.name === child.requestedName,
        }
      : null;
    if (!collision) {
      // Reserve every explicit sibling name before any generated candidate.
      used.add(token(child.displayName));
      continue;
    }
    if (child.blocked) continue;
    const choice: ImportChoice = child.choice ?? { action: "keep_both" };
    child.choice = choice;
    if (choice.action === "skip") {
      skipSubtree(child);
      continue;
    }
    if (choice.action === "replace") {
      // Replace updates an existing File's representation; it can never turn
      // a source Directory into that File or merge into a Directory.
      if (collision.kind !== "file" || child.kind !== "file") {
        child.blocked = "cannot_replace";
        continue;
      }
      child.action = "replace";
      child.existingNodeId = collision.nodeId;
      child.displayName = collision.name;
      continue;
    }
    if (choice.action === "rename") {
      const renamed = canonicalRename(choice.name);
      if (renamed === null) {
        child.blocked = "invalid_name";
        continue;
      }
      child.displayName = renamed;
      const renamedToken = token(renamed);
      if (used.has(renamedToken)) {
        child.blocked = "name_in_use";
        continue;
      }
      used.add(renamedToken);
      child.action = "create";
      continue;
    }
    pendingGenerated.push(child);
  }

  for (const child of pendingGenerated) {
    let chosen: string | null = null;
    for (let number = 2; number <= 100_000; number++) {
      let candidate: CanonicalSegment;
      try {
        candidate = keepBothCandidate(child.requestedName, number);
      } catch (error) {
        if (error instanceof NamespaceError && error.code === "generated-name-invalid") break;
        throw error;
      }
      const candidateToken = token(candidate.display);
      if (!used.has(candidateToken)) {
        used.add(candidateToken);
        chosen = candidate.display;
        break;
      }
    }
    if (chosen === null) {
      child.blocked = "over_limit";
      continue;
    }
    child.displayName = chosen;
    child.generated = true;
  }

  for (const child of node.children) {
    if (child.kind === "directory" && child.action === "create" && !child.blocked) {
      allocateDirectory(child, new Map());
    }
  }
}

function recomputeDisplayPaths(node: ImportReviewNode): void {
  for (const child of node.children) {
    child.displayPath = [...node.displayPath, child.displayName];
    recomputeDisplayPaths(child);
  }
}

/** Nothing under a blocked parent can be planned, whichever specific choice resolves it. */
function markParentBlocked(node: ImportReviewNode): void {
  for (const child of node.children) {
    if (child.blocked === null) child.blocked = "parent_blocked";
    markParentBlocked(child);
  }
}

function flatten(tree: ImportReviewNode): ImportReviewNode[] {
  const nodes: ImportReviewNode[] = [];
  const visit = (node: ImportReviewNode): void => {
    for (const child of node.children) {
      nodes.push(child);
      visit(child);
    }
  };
  visit(tree);
  return nodes;
}

/**
 * Build the complete private review for one selection and target. `choices`
 * is keyed by a candidate's canonical source path; an omitted collision
 * defaults to Keep both so no name is ever overwritten silently.
 */
export function reviewImport(source: ImportSource, target: ImportTarget, choices: ImportChoices = {}): ImportReview {
  const tree: ImportReviewNode = {
    sourcePath: "",
    kind: "directory",
    parentSourcePath: null,
    requestedName: target.label,
    displayName: target.label,
    displayPath: [],
    sourceBytes: 0,
    action: "create",
    generated: false,
    collision: null,
    existingNodeId: null,
    choice: null,
    blocked: null,
    children: [],
  };
  for (const child of source.roots) tree.children.push(makeNode(child, tree));

  // Duplicate source paths are rejected before review; verify defensively so
  // Keep both can never "repair" two candidates for the same source path.
  const seen = new Set<string>();
  for (const node of flatten(tree)) {
    const key = pathToken(node.sourcePath);
    if (seen.has(key)) throw new ImportError("duplicate-source-path", { item: node.sourcePath, action: "remove" });
    seen.add(key);
    const choice = choices[node.sourcePath];
    if (choice) node.choice = choice;
  }

  const existingTokens = new Map<string, ImportCollisionSibling>();
  for (const sibling of target.siblings) {
    const key = token(sibling.name);
    if (!existingTokens.has(key)) existingTokens.set(key, sibling);
  }

  allocateDirectory(tree, existingTokens);
  recomputeDisplayPaths(tree);
  for (const node of flatten(tree)) {
    if (
      node.kind === "directory" &&
      node.blocked &&
      node.blocked !== "parent_skipped" &&
      node.blocked !== "parent_blocked"
    )
      markParentBlocked(node);
  }
  const nodes = flatten(tree);

  const counts: ImportReviewCounts = {
    sources: source.nodeCount,
    createFiles: 0,
    createDirectories: 0,
    replaces: 0,
    skips: 0,
    maxDepth: source.maxDepth,
    compressedBytes: source.compressedBytes,
    expandedBytes: source.expandedBytes,
    // Only comments attached to Files this review will create are imported;
    // skipped or replaced candidates contribute none.
    comments: 0,
  };
  const generatedNames: string[] = [];
  const blocked: ImportReviewNode[] = [];
  for (const node of nodes) {
    if (node.blocked === "parent_skipped") {
      counts.skips += 1;
      continue;
    }
    if (node.blocked === "parent_blocked") continue;
    if (node.action === "skip") {
      counts.skips += 1;
      continue;
    }
    if (node.blocked) {
      blocked.push(node);
      continue;
    }
    if (node.action === "replace") counts.replaces += 1;
    else if (node.kind === "file") {
      counts.createFiles += 1;
      counts.comments += source.comments.get(node.sourcePath)?.length ?? 0;
    } else counts.createDirectories += 1;
    if (node.generated) generatedNames.push(node.displayPath.join("/"));
  }
  const planCount = counts.createFiles + counts.createDirectories + counts.replaces;
  const empty = planCount === 0;
  return {
    status: blocked.length === 0 ? "ok" : "blocked",
    target,
    tree,
    nodes,
    counts,
    generatedNames,
    blocked,
    empty,
    canConfirm: blocked.length === 0 && !empty,
  };
}

/** True when a File candidate may take the explicit File Replace choice. */
export function canReplace(node: ImportReviewNode): boolean {
  return node.kind === "file" && node.collision?.existingKind === "file";
}
