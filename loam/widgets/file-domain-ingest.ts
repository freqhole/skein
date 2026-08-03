// ---------------------------------------------------------------------------
// file-domain-ingest.ts — domain-specific ingest for a manually-picked file
// domain (thumbnail generation, document page-rendering + widget conversion).
//
// mirrors peedeeeff/render-client.ts's claim/release pattern exactly
// (processingClaimedBy/processingClaimedAt → domainIngestClaimedBy/At, same
// stale-claim window, same "best-effort, idempotent, a racing claim is
// harmless" philosophy) rather than inventing a new coordination scheme.
// only triggered when a user fills in a domain the auto-detector couldn't
// determine (widgets/file.ts's fileEditableProps) — an already-auto-
// detected domain (set at upload/snatch time) never goes through this path.
// ---------------------------------------------------------------------------

import { log } from "@freqhole/reliquary/utils";
import type { CanvasStore } from "../src/canvas/canvas-store";
import { getThumbnailDataUrl } from "../src/file-utils/thumbnail-utils";

const TAG = "file.domain-ingest";

/** a domain-ingest claim older than this is considered abandoned (peer
 *  likely went offline mid-ingest) and may be reclaimed — same window as
 *  peedeeeff's PROCESSING_CLAIM_STALE_MS. */
export const DOMAIN_INGEST_CLAIM_STALE_MS = 45_000;

/**
 * a generic mime matching the user's manually-picked domain, to send in
 * place of the original (auto-detection-derived, apparently wrong) mime
 * when asking for a thumbnail. retrying with the SAME mime that already
 * failed classification would just fail identically — local/peer thumbnail
 * dispatch branches purely on mime prefix, and ffmpeg/ffprobe don't care
 * about the mime label at all, only the real file bytes, so this is a safe
 * "trust the user, try harder" override rather than a real reclassification.
 */
function domainToMimeOverride(domain: string): string | undefined {
  switch (domain) {
    case "photo":
      return "image/jpeg";
    case "video":
      return "video/mp4";
    case "audio":
      return "audio/mpeg";
    case "document":
      return "application/pdf";
    default:
      return undefined;
  }
}

/** the subset of `FileState` this module ever reads/writes. */
export interface DomainIngestState {
  thumbnailDataUrl: string;
  domain: string;
  domainIngestState: string;
  domainIngestClaimedBy: string;
  domainIngestClaimedAt: number;
}

/** minimal doc-access interface — satisfied by a mounted `WidgetDoc<S>`
 *  wrapped as `{ current: () => ctx.doc.current, change: (fn) =>
 *  ctx.doc.change(fn) }`. */
export interface DomainIngestDoc {
  current(): DomainIngestState;
  change(fn: (draft: DomainIngestState) => void): void;
}

/** claim the ingest job for this peer, unless someone else already holds a
 *  fresh (non-stale) claim. */
export function tryClaimDomainIngest(doc: DomainIngestDoc, canvasStore: CanvasStore | undefined): boolean {
  const state = doc.current();
  const localId = canvasStore?.localNodeId ?? "";
  const now = Date.now();
  const claimedBy = state.domainIngestClaimedBy;
  const claimAge = now - (state.domainIngestClaimedAt || 0);

  if (claimedBy && claimedBy !== localId && claimAge < DOMAIN_INGEST_CLAIM_STALE_MS) {
    return false;
  }

  doc.change((draft) => {
    draft.domainIngestClaimedBy = localId;
    draft.domainIngestClaimedAt = now;
    draft.domainIngestState = "processing";
  });
  return true;
}

/** clear the claim so another peer can retry immediately instead of
 *  waiting out the staleness timeout. */
export function releaseDomainIngestClaim(doc: DomainIngestDoc, canvasStore: CanvasStore | undefined): void {
  const localId = canvasStore?.localNodeId ?? "";
  if (doc.current().domainIngestClaimedBy !== localId) return;
  doc.change((draft) => {
    draft.domainIngestClaimedBy = "";
    draft.domainIngestClaimedAt = 0;
  });
}

/**
 * manual override for a stuck job: clears the claim regardless of who holds
 * it, and reverts `domain` to unset so the file-type select reappears.
 * safe even if the original claimant is still actually working — results
 * (thumbnail/pages) are idempotent for a given blobId, so a stale write
 * landing after a fresh retry started is a harmless rare edge case, not a
 * correctness issue (same tradeoff peedeeeff already accepts).
 */
export function cancelDomainIngest(doc: DomainIngestDoc): void {
  doc.change((draft) => {
    draft.domainIngestClaimedBy = "";
    draft.domainIngestClaimedAt = 0;
    draft.domainIngestState = "";
    draft.domain = "";
  });
}

export interface RunDomainIngestOptions {
  isDestroyed?: () => boolean;
  /** tauri-only: convert this widget into a peedeeeff widget once its pages
   *  are rendered. only invoked for domain === "document" with a pdf mime.
   *  returns false on failure/timeout (does NOT throw). */
  convertToDocument?: (blobId: string) => Promise<boolean>;
}

/**
 * runs the domain-specific ingest steps for a freshly-picked (not auto-
 * detected) domain: thumbnail generation for every domain except "file"
 * (which has nothing to ingest), or document page-rendering + widget
 * conversion for "document" + a real pdf mime. claim-guarded so only one
 * connected peer attempts this at a time. on failure, reverts `domain` to
 * unset so the caller's file-type select reappears for a retry.
 */
export async function runDomainIngest(
  doc: DomainIngestDoc,
  blobId: string,
  domain: string,
  mime: string,
  canvasStore: CanvasStore | undefined,
  options: RunDomainIngestOptions = {}
): Promise<void> {
  // "file" is the generic catch-all — no thumbnail/page-render makes sense
  // for an unknown binary, so there's nothing to claim or process.
  if (domain === "file") return;

  if (!tryClaimDomainIngest(doc, canvasStore)) return;

  try {
    if (domain === "document" && mime === "application/pdf" && options.convertToDocument) {
      const ok = await options.convertToDocument(blobId);
      if (!ok) throw new Error("document page rendering failed or timed out");
      // success replaces/removes this widget entirely — no doc left to
      // release the claim on (isDestroyed() will be true by now, so the
      // finally block below already skips it).
      return;
    }

    if (!doc.current().thumbnailDataUrl) {
      const dataUrl = await getThumbnailDataUrl(blobId, {
        size: 200,
        square: domain === "photo" || domain === "document",
        peers: canvasStore?.peers(),
        mimeOverride: domainToMimeOverride(domain),
      });
      if (options.isDestroyed?.()) return;
      if (!dataUrl) throw new Error(`no peer could produce a ${domain} thumbnail`);
      doc.change((draft) => {
        draft.thumbnailDataUrl = dataUrl;
      });
    }

    if (options.isDestroyed?.()) return;
    doc.change((draft) => {
      draft.domainIngestState = "";
    });
  } catch (err) {
    log.warn(TAG, `domain ingest failed for domain=${domain}:`, err);
    if (!options.isDestroyed?.()) {
      doc.change((draft) => {
        draft.domainIngestState = "";
        draft.domain = "";
      });
    }
  } finally {
    if (!options.isDestroyed?.()) releaseDomainIngestClaim(doc, canvasStore);
  }
}
