// ---------------------------------------------------------------------------
// blob-backed storage for "image"-typed editable widget props (canvas-card's
// previewUrl, link's previewUrl, image widget's url) — these used to store a
// full base64 data URL directly as a plain automerge string field, which
// bloats doc history badly: reassigning one multi-KB base64 blob to another
// forces automerge to myers-diff two near-random strings, generating close
// to one op per differing character run. see docs/narthex-doc-history-plan.md.
//
// fix: save the bytes into the existing content-addressed blob store and
// keep only a short `blob:<id>` reference in the automerge doc. resolution
// is a no-op for anything that isn't one of our refs (a legacy raw data:
// URL already sitting in an existing doc, an external http(s) URL, or an
// empty string) — so old docs keep working without a data migration.
// ---------------------------------------------------------------------------

import { log } from "@freqhole/reliquary/utils";
import { storeBlob, getBlobObjectURL } from "../storage/blob-store";
import { base64ToBytes } from "./file-shared";

const TAG = "image-prop-blob";
const BLOB_REF_PREFIX = "blob:";

export function isImageBlobRef(value: string): boolean {
  return value.startsWith(BLOB_REF_PREFIX);
}

/** save a `data:<mime>;base64,...` URL into the blob store and return a
 *  `blob:<id>` reference to store in the doc instead. returns the input
 *  unchanged if it isn't a base64 data URL (external URL, empty string). */
export async function saveImageDataUrlAsBlobRef(dataUrl: string): Promise<string> {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) return dataUrl;
  const [, mime, b64] = match;
  const bytes = base64ToBytes(b64);
  const record = await storeBlob(bytes.buffer as ArrayBuffer, {
    filename: `preview.${mime.split("/")[1] || "bin"}`,
    mime,
    blob_type: "preview",
  });
  return `${BLOB_REF_PREFIX}${record.blob_id}`;
}

/** resolve a stored prop value to a URL usable by `Assets.load`/`<img>` —
 *  a `blob:<id>` ref resolves to an object URL, anything else (legacy data:
 *  URL, external URL, empty string) passes through unchanged. returns "" if
 *  a blob ref can't be resolved (blob missing locally). */
export async function resolveImagePropUrl(value: string): Promise<string> {
  if (!value || !isImageBlobRef(value)) return value;
  const blobId = value.slice(BLOB_REF_PREFIX.length);
  try {
    const url = await getBlobObjectURL(blobId);
    return url ?? "";
  } catch (err) {
    log.warn(TAG, "failed to resolve image blob ref:", blobId.slice(0, 12), err);
    return "";
  }
}
