//! stage-0 spike: an OPFS-backed iroh-blobs store living entirely OUTSIDE
//! the iroh-blobs crate — see skein/docs/opfs-store-implementation-plan.md
//! phase C.
//!
//! the key discovery this module proves: iroh-blobs 0.103 exposes everything
//! a custom store actor needs — `api::proto` is pub (the `Command` enum and
//! the irpc-generated `*Msg` types), `MemStore::from_sender(client)` is plain
//! pub, and the bao-tree traversal helpers work against public traits
//! (`ReadBytesAt` + `Outboard`). so the browser store needs ZERO fork diffs
//! and can be upstreamed later as a self-contained module.
//!
//! stage-0 scope (a spike, not the final store):
//! - complete blobs are persisted as OPFS files (`<hash>.data` /
//!   `<hash>.obao`) via `FileSystemSyncAccessHandle` (worker-context only);
//!   the handles stay open for reads, which also acts as a same-origin lock.
//! - partial blobs (mid `import_bao`) live in memory and are flushed to
//!   OPFS when the bitfield completes. cross-reload resume of partials is
//!   phase C proper, not stage 0.
//! - commands handled: ImportBytes, ImportByteStream, ImportBao, ExportBao,
//!   ExportRanges, Observe, BlobStatus, tags, CreateTempTag, SyncDb,
//!   WaitIdle, ClearProtected, Shutdown. ListBlobs/Batch/DeleteBlobs/
//!   ImportPath/ExportPath are dropped (callers see a closed channel).
//! - temp tags are created leaked (no drop tracking) — fine while the store
//!   runs without gc, which stage 0 does.
//! - the actor handles imports inline (bounded work) and spawns streaming
//!   ops (export/observe/import_bao); WaitIdle acks immediately since there
//!   is no JoinSet bookkeeping yet.

use std::{
    cell::RefCell,
    collections::{BTreeMap, HashMap},
    io,
    ops::Deref,
    rc::Rc,
};

use bao_tree::{
    blake3,
    io::{
        mixed::{traverse_ranges_validated, EncodedItem, ReadBytesAt},
        outboard::PreOrderMemOutboard,
        BaoContentItem, EncodeError, Leaf,
    },
    io::sync::Outboard,
    BaoTree, ChunkNum, ChunkRanges, TreeNode,
};
use bytes::Bytes;
use iroh_blobs::{
    api::{
        blobs::{AddProgressItem, Bitfield, BlobStatus},
        proto::{
            BlobStatusMsg, BlobStatusRequest, Command, CreateTagMsg, CreateTagRequest,
            CreateTempTagMsg, ExportBaoMsg, ExportBaoRequest, ExportRangesItem, ExportRangesMsg,
            ExportRangesRequest, ImportBaoMsg, ImportBaoRequest, ImportByteStreamMsg,
            ImportByteStreamUpdate, ImportBytesMsg, ImportBytesRequest, ListTagsMsg, ObserveMsg,
            ObserveRequest, SetTagMsg, SetTagRequest, ShutdownMsg, SyncDbMsg, WaitIdleMsg,
        },
        tags::TagInfo,
        Tag, TempTag,
    },
    protocol::ChunkRangesExt,
    store::{mem::MemStore, IROH_BLOCK_SIZE},
    Hash, HashAndFormat,
};
use range_collections::range_set::RangeSetRange;
use tokio::sync::watch;
use tracing::{debug, trace, warn};
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;
use web_sys::{
    FileSystemDirectoryHandle, FileSystemFileHandle, FileSystemGetDirectoryOptions,
    FileSystemGetFileOptions, FileSystemReadWriteOptions, FileSystemSyncAccessHandle,
};

// ---------------------------------------------------------------------------
// OPFS plumbing
// ---------------------------------------------------------------------------

fn js_err(context: &str, e: wasm_bindgen::JsValue) -> String {
    format!("{context}: {e:?}")
}

/// resolve the OPFS root and open (creating if needed) the store directory.
/// works in both worker and window scopes, but sync access handles can only
/// be created in a dedicated worker — window contexts fail at open_sync().
async fn open_store_dir(dir_name: &str) -> Result<FileSystemDirectoryHandle, String> {
    let global = js_sys::global();
    let storage = if let Some(scope) = global.dyn_ref::<web_sys::WorkerGlobalScope>() {
        scope.navigator().storage()
    } else if let Some(win) = global.dyn_ref::<web_sys::Window>() {
        win.navigator().storage()
    } else {
        return Err("no global scope with navigator.storage".to_string());
    };
    let root: FileSystemDirectoryHandle = JsFuture::from(storage.get_directory())
        .await
        .map_err(|e| js_err("getDirectory failed (OPFS unavailable?)", e))?
        .dyn_into()
        .map_err(|e| js_err("getDirectory returned non-directory", e))?;
    let opts = FileSystemGetDirectoryOptions::new();
    opts.set_create(true);
    let dir: FileSystemDirectoryHandle =
        JsFuture::from(root.get_directory_handle_with_options(dir_name, &opts))
            .await
            .map_err(|e| js_err("getDirectoryHandle failed", e))?
            .dyn_into()
            .map_err(|e| js_err("getDirectoryHandle returned non-directory", e))?;
    Ok(dir)
}

/// open a sync access handle for a file in the store dir (creates the file).
/// only works in a dedicated worker.
async fn open_sync(
    dir: &FileSystemDirectoryHandle,
    name: &str,
) -> Result<FileSystemSyncAccessHandle, String> {
    let opts = FileSystemGetFileOptions::new();
    opts.set_create(true);
    let fh: FileSystemFileHandle = JsFuture::from(dir.get_file_handle_with_options(name, &opts))
        .await
        .map_err(|e| js_err("getFileHandle failed", e))?
        .dyn_into()
        .map_err(|e| js_err("getFileHandle returned non-file", e))?;
    let sah: FileSystemSyncAccessHandle = JsFuture::from(fh.create_sync_access_handle())
        .await
        .map_err(|e| js_err("createSyncAccessHandle failed (not in a worker?)", e))?
        .dyn_into()
        .map_err(|e| js_err("createSyncAccessHandle returned unexpected type", e))?;
    Ok(sah)
}

/// synchronous exact read at an offset from a sync access handle.
fn sah_read_exact(
    sah: &FileSystemSyncAccessHandle,
    offset: u64,
    len: usize,
) -> io::Result<Vec<u8>> {
    let mut buf = vec![0u8; len];
    let opts = FileSystemReadWriteOptions::new();
    opts.set_at(offset as f64);
    let n = sah
        .read_with_u8_array_and_options(&mut buf, &opts)
        .map_err(|e| io::Error::other(format!("OPFS read failed: {e:?}")))?;
    if (n as usize) != len {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            format!("short OPFS read: wanted {len}, got {n}"),
        ));
    }
    Ok(buf)
}

/// synchronous whole-file write (truncate + write at 0 + flush).
fn sah_write_all(sah: &FileSystemSyncAccessHandle, data: &[u8]) -> io::Result<()> {
    sah.truncate_with_f64(0.0)
        .map_err(|e| io::Error::other(format!("OPFS truncate failed: {e:?}")))?;
    let opts = FileSystemReadWriteOptions::new();
    opts.set_at(0.0);
    let n = sah
        .write_with_u8_array_and_options(data, &opts)
        .map_err(|e| io::Error::other(format!("OPFS write failed: {e:?}")))?;
    if (n as usize) != data.len() {
        return Err(io::Error::other(format!(
            "short OPFS write: wanted {}, wrote {}",
            data.len(),
            n
        )));
    }
    sah.flush()
        .map_err(|e| io::Error::other(format!("OPFS flush failed: {e:?}")))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// entry state
// ---------------------------------------------------------------------------

/// grow-on-write in-memory buffer for partial blobs (mid import_bao).
/// holes read back as zeros — the validated bao traversal detects any
/// attempt to export unwritten ranges via hash mismatch, and exports check
/// the bitfield first anyway. (the crate-private SparseMemFile tracks valid
/// ranges explicitly; stage 0 doesn't need that precision.)
#[derive(Default)]
struct GrowVec {
    data: Vec<u8>,
}

impl GrowVec {
    fn write_at(&mut self, offset: u64, buf: &[u8]) {
        let end = offset as usize + buf.len();
        if self.data.len() < end {
            self.data.resize(end, 0);
        }
        self.data[offset as usize..end].copy_from_slice(buf);
    }

    fn read_bytes_at(&self, offset: u64, size: usize) -> io::Result<Bytes> {
        let start = offset as usize;
        let end = start + size;
        if end > self.data.len() {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "read past end of partial data",
            ));
        }
        Ok(Bytes::copy_from_slice(&self.data[start..end]))
    }
}

struct PartialState {
    data: GrowVec,
    outboard: GrowVec,
    size: u64,
    bitfield: Bitfield,
}

impl Default for PartialState {
    fn default() -> Self {
        Self {
            data: GrowVec::default(),
            outboard: GrowVec::default(),
            size: 0,
            bitfield: Bitfield::empty(),
        }
    }
}

/// a complete blob, persisted to OPFS. the sync access handles stay open
/// for the lifetime of the entry — reads are synchronous, and the open
/// handle doubles as an exclusive same-origin lock on the files.
struct CompleteState {
    size: u64,
    data: FileSystemSyncAccessHandle,
    /// None when the blob fits in one block group (empty outboard)
    outboard: Option<FileSystemSyncAccessHandle>,
}

enum EntryState {
    Partial(PartialState),
    Complete(CompleteState),
}

impl EntryState {
    fn bitfield(&self) -> Bitfield {
        match self {
            Self::Partial(p) => p.bitfield.clone(),
            Self::Complete(c) => Bitfield::complete(c.size),
        }
    }

    fn size(&self) -> u64 {
        match self {
            Self::Partial(p) => p.size,
            Self::Complete(c) => c.size,
        }
    }
}

struct EntryInner {
    hash: Hash,
    state: watch::Sender<EntryState>,
}

#[derive(Clone)]
struct Entry(Rc<EntryInner>);

impl Entry {
    fn new(hash: Hash) -> Self {
        Self(Rc::new(EntryInner {
            hash,
            state: watch::Sender::new(EntryState::Partial(PartialState::default())),
        }))
    }

    fn bitfield(&self) -> Bitfield {
        self.0.state.borrow().bitfield()
    }
}

// ---------------------------------------------------------------------------
// bao readers over an entry (sync traits, used by traverse_ranges_validated)
// ---------------------------------------------------------------------------

struct DataReader(Entry);

impl ReadBytesAt for DataReader {
    fn read_bytes_at(&self, offset: u64, size: usize) -> io::Result<Bytes> {
        match self.0 .0.state.borrow().deref() {
            EntryState::Partial(p) => p.data.read_bytes_at(offset, size),
            EntryState::Complete(c) => Ok(sah_read_exact(&c.data, offset, size)?.into()),
        }
    }
}

struct OutboardReader {
    hash: blake3::Hash,
    tree: BaoTree,
    entry: Entry,
}

impl Outboard for OutboardReader {
    fn root(&self) -> blake3::Hash {
        self.hash
    }

    fn tree(&self) -> BaoTree {
        self.tree
    }

    fn load(&self, node: TreeNode) -> io::Result<Option<(blake3::Hash, blake3::Hash)>> {
        let Some(offset) = self.tree.pre_order_offset(node) else {
            return Ok(None);
        };
        let buf = match self.entry.0.state.borrow().deref() {
            EntryState::Partial(p) => p.outboard.read_bytes_at(offset * 64, 64)?.to_vec(),
            EntryState::Complete(c) => match &c.outboard {
                Some(sah) => sah_read_exact(sah, offset * 64, 64)?,
                None => {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "no outboard for single-group blob",
                    ))
                }
            },
        };
        let left: [u8; 32] = buf[..32].try_into().unwrap();
        let right: [u8; 32] = buf[32..].try_into().unwrap();
        Ok(Some((left.into(), right.into())))
    }
}

/// adapter: irpc mpsc sender as a bao-tree encoded-item sink (the
/// crate-private BaoTreeSender reimplemented — it's 10 lines).
struct EncodedItemSender<'a>(&'a mut irpc::channel::mpsc::Sender<EncodedItem>);

impl bao_tree::io::mixed::Sender for EncodedItemSender<'_> {
    type Error = irpc::channel::SendError;
    async fn send(&mut self, item: EncodedItem) -> Result<(), Self::Error> {
        self.0.send(item).await
    }
}

// ---------------------------------------------------------------------------
// the actor
// ---------------------------------------------------------------------------

struct Ctx {
    dir: FileSystemDirectoryHandle,
    entries: RefCell<HashMap<Hash, Entry>>,
    tags: RefCell<BTreeMap<Tag, HashAndFormat>>,
}

impl Ctx {
    fn get_or_create_entry(&self, hash: Hash) -> Entry {
        self.entries
            .borrow_mut()
            .entry(hash)
            .or_insert_with(|| Entry::new(hash))
            .clone()
    }

    fn get(&self, hash: &Hash) -> Option<Entry> {
        self.entries.borrow().get(hash).cloned()
    }

    /// persist complete blob bytes + outboard to OPFS, returning the open
    /// handles that become the entry's CompleteState.
    async fn persist_complete(
        &self,
        hash: &Hash,
        data: &[u8],
        outboard: &[u8],
    ) -> Result<CompleteState, String> {
        let hex = hash.to_hex();
        let data_sah = open_sync(&self.dir, &format!("{hex}.data")).await?;
        sah_write_all(&data_sah, data).map_err(|e| e.to_string())?;
        let outboard_sah = if outboard.is_empty() {
            None
        } else {
            let sah = open_sync(&self.dir, &format!("{hex}.obao")).await?;
            sah_write_all(&sah, outboard).map_err(|e| e.to_string())?;
            Some(sah)
        };
        Ok(CompleteState {
            size: data.len() as u64,
            data: data_sah,
            outboard: outboard_sah,
        })
    }
}

/// public handle: an iroh-blobs Store backed by the OPFS actor. wraps
/// MemStore purely for its pub from_sender constructor + Deref<Store>.
pub struct OpfsStore {
    inner: MemStore,
}

impl Deref for OpfsStore {
    type Target = iroh_blobs::api::Store;
    fn deref(&self) -> &Self::Target {
        self.inner.deref()
    }
}

impl OpfsStore {
    /// spawn the store actor against an OPFS directory. worker context
    /// required for actual blob persistence (sync access handles).
    pub async fn new(dir_name: &str) -> Result<Self, String> {
        let dir = open_store_dir(dir_name).await?;
        let (tx, rx) = tokio::sync::mpsc::channel::<Command>(32);
        let ctx = Rc::new(Ctx {
            dir,
            entries: RefCell::new(HashMap::new()),
            tags: RefCell::new(BTreeMap::new()),
        });
        wasm_bindgen_futures::spawn_local(actor_loop(rx, ctx));
        Ok(Self {
            inner: MemStore::from_sender(tx.into()),
        })
    }
}

async fn actor_loop(mut rx: tokio::sync::mpsc::Receiver<Command>, ctx: Rc<Ctx>) {
    while let Some(cmd) = rx.recv().await {
        trace!("opfs-store command: {:?}", cmd);
        match cmd {
            Command::ImportBytes(ImportBytesMsg {
                inner: ImportBytesRequest { data, format, .. },
                tx,
                ..
            }) => {
                // inline: outboard compute + OPFS write are bounded work
                if let Err(e) = import_bytes(&ctx, data, format, tx).await {
                    warn!("opfs-store import_bytes failed: {e}");
                }
            }
            Command::ImportByteStream(ImportByteStreamMsg {
                inner, tx, mut rx, ..
            }) => {
                // drain the chunk stream, then reuse the bytes import path
                let mut buf = Vec::new();
                let mut failed = false;
                loop {
                    match rx.recv().await {
                        Ok(Some(ImportByteStreamUpdate::Bytes(chunk))) => {
                            buf.extend_from_slice(&chunk);
                            tx.send(AddProgressItem::CopyProgress(buf.len() as u64))
                                .await
                                .ok();
                        }
                        Ok(Some(ImportByteStreamUpdate::Done)) => break,
                        Ok(None) | Err(_) => {
                            failed = true;
                            break;
                        }
                    }
                }
                if failed {
                    tx.send(AddProgressItem::Error(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "byte stream ended unexpectedly",
                    )))
                    .await
                    .ok();
                } else if let Err(e) = import_bytes(&ctx, buf.into(), inner.format, tx).await {
                    warn!("opfs-store import_byte_stream failed: {e}");
                }
            }
            Command::ImportBao(ImportBaoMsg {
                inner: ImportBaoRequest { hash, size },
                rx,
                tx,
                ..
            }) => {
                let entry = ctx.get_or_create_entry(hash);
                let ctx = ctx.clone();
                wasm_bindgen_futures::spawn_local(import_bao(ctx, entry, size.get(), rx, tx));
            }
            Command::ExportBao(ExportBaoMsg {
                inner: ExportBaoRequest { hash, ranges, .. },
                tx,
                ..
            }) => {
                let entry = ctx.get(&hash);
                wasm_bindgen_futures::spawn_local(export_bao(entry, ranges, tx));
            }
            Command::ExportRanges(ExportRangesMsg { inner, tx, .. }) => {
                let entry = ctx.get(&inner.hash);
                wasm_bindgen_futures::spawn_local(export_ranges(entry, inner, tx));
            }
            Command::Observe(ObserveMsg {
                inner: ObserveRequest { hash },
                tx,
                ..
            }) => {
                let entry = ctx.get_or_create_entry(hash);
                wasm_bindgen_futures::spawn_local(observe(entry, tx));
            }
            Command::BlobStatus(BlobStatusMsg {
                inner: BlobStatusRequest { hash },
                tx,
                ..
            }) => {
                let status = match ctx.get(&hash) {
                    None => BlobStatus::NotFound,
                    Some(entry) => {
                        let bitfield = entry.bitfield();
                        if bitfield.is_complete() {
                            BlobStatus::Complete {
                                size: bitfield.size(),
                            }
                        } else {
                            BlobStatus::Partial {
                                size: bitfield.validated_size(),
                            }
                        }
                    }
                };
                tx.send(status).await.ok();
            }
            Command::SetTag(SetTagMsg {
                inner: SetTagRequest { name, value },
                tx,
                ..
            }) => {
                ctx.tags.borrow_mut().insert(name, value);
                tx.send(Ok(())).await.ok();
            }
            Command::CreateTag(CreateTagMsg {
                inner: CreateTagRequest { value },
                tx,
                ..
            }) => {
                let tag = Tag::auto(n0_future::time::SystemTime::now(), |t| {
                    ctx.tags.borrow().contains_key(t)
                });
                ctx.tags.borrow_mut().insert(tag.clone(), value);
                tx.send(Ok(tag)).await.ok();
            }
            Command::ListTags(ListTagsMsg { inner, tx, .. }) => {
                let tags: Vec<_> = ctx
                    .tags
                    .borrow()
                    .iter()
                    .filter(|(tag, value)| {
                        if let Some(from) = &inner.from {
                            if *tag < from {
                                return false;
                            }
                        }
                        if let Some(to) = &inner.to {
                            if *tag >= to {
                                return false;
                            }
                        }
                        (inner.raw && value.format.is_raw())
                            || (inner.hash_seq && value.format.is_hash_seq())
                    })
                    .map(|(tag, value)| {
                        Ok(TagInfo {
                            name: tag.clone(),
                            hash: value.hash,
                            format: value.format,
                        })
                    })
                    .collect();
                tx.send(tags).await.ok();
            }
            Command::CreateTempTag(CreateTempTagMsg { inner, tx, .. }) => {
                // stage 0: leaked temp tag (no drop tracking, no gc running)
                tx.send(TempTag::new(inner.value, None)).await.ok();
            }
            Command::ListTempTags(cmd) => {
                cmd.tx.send(Vec::new()).await.ok();
            }
            Command::SyncDb(SyncDbMsg { tx, .. }) => {
                tx.send(Ok(())).await.ok();
            }
            Command::WaitIdle(WaitIdleMsg { tx, .. }) => {
                // stage 0: no task bookkeeping — ack immediately
                tx.send(()).await.ok();
            }
            Command::ClearProtected(cmd) => {
                cmd.tx.send(Ok(())).await.ok();
            }
            Command::Shutdown(ShutdownMsg { tx, .. }) => {
                debug!("opfs-store shutting down");
                tx.send(()).await.ok();
                return;
            }
            other => {
                // ListBlobs / Batch / DeleteBlobs / DeleteTags / RenameTag /
                // ImportPath / ExportPath — not needed for stage 0. dropping
                // the msg drops its tx, which surfaces as a channel error to
                // the caller instead of a hang.
                debug!("opfs-store: unhandled command (stage 0): {:?}", other);
            }
        }
    }
    debug!("opfs-store actor: command channel closed");
}

/// import in-memory bytes: compute the outboard, persist both files to
/// OPFS, flip the entry to Complete, hand back a (leaked) temp tag.
async fn import_bytes(
    ctx: &Rc<Ctx>,
    data: Bytes,
    format: iroh_blobs::BlobFormat,
    tx: irpc::channel::mpsc::Sender<AddProgressItem>,
) -> Result<(), String> {
    tx.send(AddProgressItem::Size(data.len() as u64))
        .await
        .map_err(|e| e.to_string())?;
    tx.send(AddProgressItem::CopyDone)
        .await
        .map_err(|e| e.to_string())?;
    let outboard = PreOrderMemOutboard::create(&data, IROH_BLOCK_SIZE);
    let hash: Hash = outboard.root().into();

    let complete = match ctx.persist_complete(&hash, &data, &outboard.data).await {
        Ok(c) => c,
        Err(e) => {
            tx.send(AddProgressItem::Error(io::Error::other(e.clone())))
                .await
                .ok();
            return Err(e);
        }
    };

    let entry = ctx.get_or_create_entry(hash);
    entry.0.state.send_if_modified(|state| {
        if matches!(state, EntryState::Complete(_)) {
            return false;
        }
        *state = EntryState::Complete(complete);
        true
    });

    let tt = TempTag::new(HashAndFormat { hash, format }, None);
    tx.send(AddProgressItem::Done(tt))
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn chunk_range(leaf: &Leaf) -> ChunkRanges {
    let start = ChunkNum::chunks(leaf.offset);
    let end = ChunkNum::chunks(leaf.offset + leaf.data.len() as u64);
    (start..end).into()
}

/// receive verified bao content into a partial entry; flip to Complete
/// (persisting to OPFS) when the bitfield fills up.
async fn import_bao(
    ctx: Rc<Ctx>,
    entry: Entry,
    size: u64,
    mut stream: irpc::channel::mpsc::Receiver<BaoContentItem>,
    tx: irpc::channel::oneshot::Sender<iroh_blobs::api::Result<()>>,
) {
    entry.0.state.send_if_modified(|state| {
        if let EntryState::Partial(p) = state {
            p.size = size;
        }
        false
    });
    let tree = BaoTree::new(size, IROH_BLOCK_SIZE);
    loop {
        let item = match stream.recv().await {
            Ok(Some(item)) => item,
            Ok(None) => break,
            Err(e) => {
                warn!("opfs-store import_bao stream error: {e:?}");
                break;
            }
        };
        // buffer writes + bitfield update are sync; persistence on
        // completion is async, so it happens outside send_if_modified.
        let mut completed_payload: Option<(Vec<u8>, Vec<u8>)> = None;
        entry.0.state.send_if_modified(|state| {
            let EntryState::Partial(partial) = state else {
                return false; // already complete
            };
            match &item {
                BaoContentItem::Parent(parent) => {
                    if let Some(offset) = tree.pre_order_offset(parent.node) {
                        let mut pair = [0u8; 64];
                        pair[..32].copy_from_slice(parent.pair.0.as_bytes());
                        pair[32..].copy_from_slice(parent.pair.1.as_bytes());
                        partial.outboard.write_at(offset * 64, &pair);
                    }
                    false
                }
                BaoContentItem::Leaf(leaf) => {
                    partial.data.write_at(leaf.offset, &leaf.data);
                    let added = chunk_range(leaf);
                    let update = partial.bitfield.update(&Bitfield::new(added, size));
                    if update.new_state().complete {
                        completed_payload = Some((
                            std::mem::take(&mut partial.data).data,
                            std::mem::take(&mut partial.outboard).data,
                        ));
                    }
                    update.changed()
                }
            }
        });
        if let Some((data, outboard)) = completed_payload {
            match ctx.persist_complete(&entry.0.hash, &data, &outboard).await {
                Ok(complete) => {
                    entry.0.state.send_if_modified(|state| {
                        *state = EntryState::Complete(complete);
                        true
                    });
                }
                Err(e) => {
                    warn!("opfs-store: persisting completed blob failed: {e}");
                    tx.send(Err(iroh_blobs::api::Error::io(
                        io::ErrorKind::Other,
                        format!("OPFS persist failed: {e}"),
                    )))
                    .await
                    .ok();
                    return;
                }
            }
        }
    }
    tx.send(Ok(())).await.ok();
}

/// stream a verified bao encoding of the requested ranges.
async fn export_bao(
    entry: Option<Entry>,
    ranges: ChunkRanges,
    mut sender: irpc::channel::mpsc::Sender<EncodedItem>,
) {
    let Some(entry) = entry else {
        let err = EncodeError::Io(io::Error::new(io::ErrorKind::NotFound, "hash not found"));
        sender.send(err.into()).await.ok();
        return;
    };
    let size = entry.0.state.borrow().size();
    let data = DataReader(entry.clone());
    let outboard = OutboardReader {
        hash: entry.0.hash.into(),
        tree: BaoTree::new(size, IROH_BLOCK_SIZE),
        entry,
    };
    let mut tx = EncodedItemSender(&mut sender);
    traverse_ranges_validated(data, outboard, &ranges, &mut tx)
        .await
        .ok();
}

/// stream raw byte ranges (unverified reads gated by the bitfield).
async fn export_ranges(
    entry: Option<Entry>,
    cmd: ExportRangesRequest,
    mut tx: irpc::channel::mpsc::Sender<ExportRangesItem>,
) {
    let Some(entry) = entry else {
        let err = io::Error::new(io::ErrorKind::NotFound, "hash not found");
        tx.send(ExportRangesItem::Error(err.into())).await.ok();
        return;
    };
    let bitfield = entry.bitfield();
    let data = DataReader(entry);
    let size = bitfield.size();
    for range in cmd.ranges.iter() {
        let range = match range {
            RangeSetRange::Range(r) => size.min(*r.start)..size.min(*r.end),
            RangeSetRange::RangeFrom(r) => size.min(*r.start)..size,
        };
        let requested = ChunkRanges::bytes(range.start..range.end);
        if !bitfield.ranges.is_superset(&requested) {
            tx.send(ExportRangesItem::Error(
                io::Error::other(format!(
                    "missing range: {requested:?}, present: {bitfield:?}"
                ))
                .into(),
            ))
            .await
            .ok();
            return;
        }
        let bs = 1024;
        let mut offset = range.start;
        loop {
            let end: u64 = (offset + bs).min(range.end);
            let chunk_size = (end - offset) as usize;
            match data.read_bytes_at(offset, chunk_size) {
                Ok(bytes) => {
                    if tx
                        .send(
                            Leaf {
                                offset,
                                data: bytes,
                            }
                            .into(),
                        )
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
                Err(e) => {
                    tx.send(ExportRangesItem::Error(e.into())).await.ok();
                    return;
                }
            }
            offset = end;
            if offset >= range.end {
                break;
            }
        }
    }
}

/// stream bitfield snapshots: current state immediately, then on change.
async fn observe(entry: Entry, tx: irpc::channel::mpsc::Sender<Bitfield>) {
    let mut receiver = entry.0.state.subscribe();
    let value = receiver.borrow().bitfield();
    if tx.send(value).await.is_err() {
        return;
    }
    loop {
        tokio::select! {
            _ = tx.closed() => return,
            res = receiver.changed() => {
                if res.is_err() {
                    return; // sender dropped
                }
            }
        }
        let value = receiver.borrow().bitfield();
        if tx.send(value).await.is_err() {
            return;
        }
    }
}

// ---------------------------------------------------------------------------
// stage-0 selftest (driven from the blob worker via a loam e2e test)
// ---------------------------------------------------------------------------

/// end-to-end round trip against real OPFS, exercising the actor through
/// the REAL iroh-blobs api surface (blobs().add_bytes / get_bytes /
/// export_bao / import_bao_bytes / status). returns a human-readable
/// summary; errors on any mismatch. worker context required.
pub async fn selftest() -> Result<String, String> {
    // per-run dir names: two stores in the same worker must not contend for
    // the same file locks, and reruns shouldn't trip over stale files.
    let run_id = (js_sys::Math::random() * 1e9) as u64;

    // deterministic ~1.5MB payload (multiple block groups => real outboard)
    let size = 1_500_000usize;
    let mut data = vec![0u8; size];
    for (i, b) in data.iter_mut().enumerate() {
        *b = ((i * 31 + 7) % 256) as u8;
    }
    let data = Bytes::from(data);

    // store 1: import via ImportBytes, read back via ExportBao
    let store = OpfsStore::new(&format!("opfs-store-spike-{run_id}-a")).await?;
    let tag = store
        .blobs()
        .add_bytes(data.clone())
        .temp_tag()
        .await
        .map_err(|e| format!("add_bytes failed: {e:?}"))?;
    let hash = tag.hash();

    let back = store
        .blobs()
        .get_bytes(hash)
        .await
        .map_err(|e| format!("get_bytes failed: {e:?}"))?;
    if back != data {
        return Err(format!(
            "round trip mismatch: sent {} bytes, got {}",
            data.len(),
            back.len()
        ));
    }

    let status = store
        .blobs()
        .status(hash)
        .await
        .map_err(|e| format!("status failed: {e:?}"))?;
    if !matches!(status, BlobStatus::Complete { size: s } if s == size as u64) {
        return Err(format!("unexpected status: {status:?}"));
    }

    // wire-format round trip: export a verified bao stream from store 1,
    // import it into a fresh store 2 (exercises ImportBao's partial ->
    // complete flip + OPFS persistence), read back and compare.
    let bao = store
        .blobs()
        .export_bao(hash, ChunkRanges::all())
        .bao_to_vec()
        .await
        .map_err(|e| format!("export_bao failed: {e:?}"))?;

    let store2 = OpfsStore::new(&format!("opfs-store-spike-{run_id}-b")).await?;
    store2
        .blobs()
        .import_bao_bytes(hash, ChunkRanges::all(), Bytes::from(bao.clone()))
        .await
        .map_err(|e| format!("import_bao_bytes failed: {e:?}"))?;
    let back2 = store2
        .blobs()
        .get_bytes(hash)
        .await
        .map_err(|e| format!("get_bytes (store 2) failed: {e:?}"))?;
    if back2 != data {
        return Err("store-2 round trip mismatch after bao import".to_string());
    }

    Ok(format!(
        "opfs store selftest OK: {} bytes, hash {}, bao stream {} bytes, both stores verified",
        size,
        hash.to_hex(),
        bao.len()
    ))
}
