//! repair epub directories a picked file can turn out to be — some epub
//! editing tools/sync flows leave `mimetype`/`META-INF`/`OPS` loose on disk
//! under a `.epub`-named directory, instead of the zip archive the epub
//! (OCF) spec actually requires. [`repair`] re-zips a directory that looks
//! like one of these into a proper epub at a fresh temp path; callers upload
//! that instead of erroring out on the raw directory (see
//! `commands.rs`'s `blob_insert_from_path_impl`).

use std::io::Write;
use std::path::{Path, PathBuf};

/// true if `path` is a directory with a `.epub` extension (case
/// insensitive) — the only shape this module attempts to repair.
pub(crate) fn looks_like_epub_directory(path: &Path) -> bool {
    path.is_dir()
        && path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("epub"))
}

/// re-zip an exploded epub directory into a proper epub file at a fresh
/// temp path. errors — rather than silently zipping arbitrary folders — if
/// `dir` doesn't actually look like an epub: no `mimetype` file declaring
/// `application/epub+zip`, or no `META-INF/container.xml`.
pub(crate) async fn repair(dir: &Path) -> std::io::Result<PathBuf> {
    let mimetype = tokio::fs::read_to_string(dir.join("mimetype"))
        .await
        .map_err(|_| invalid_epub("missing mimetype file"))?;
    if mimetype.trim() != "application/epub+zip" {
        return Err(invalid_epub("unexpected mimetype file contents"));
    }
    if !dir.join("META-INF").join("container.xml").is_file() {
        return Err(invalid_epub("missing META-INF/container.xml"));
    }

    let dir = dir.to_path_buf();
    tokio::task::spawn_blocking(move || zip_directory(&dir))
        .await
        .map_err(|e| std::io::Error::other(e.to_string()))?
}

fn invalid_epub(detail: &str) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        format!("not a valid epub directory ({detail})"),
    )
}

/// build the actual zip archive — blocking file IO, always run via
/// `spawn_blocking` (see `repair` above), never on the async runtime directly.
fn zip_directory(dir: &Path) -> std::io::Result<PathBuf> {
    // named after a hash of the source path (not a random id) so retrying
    // the same broken directory reuses/overwrites the same temp file rather
    // than leaking a new one per attempt.
    let temp_path = std::env::temp_dir().join(format!(
        "skein-epub-repair-{}.epub",
        blake3::hash(dir.to_string_lossy().as_bytes()).to_hex()
    ));

    let file = std::fs::File::create(&temp_path)?;
    let mut writer = zip::ZipWriter::new(file);

    // the epub/OCF spec requires `mimetype` to be the first entry in the
    // archive and stored uncompressed — some readers reject the epub
    // otherwise.
    let stored =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    writer.start_file("mimetype", stored).map_err(zip_err)?;
    writer.write_all(&std::fs::read(dir.join("mimetype"))?)?;

    let deflated = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    add_dir_entries(&mut writer, dir, dir, deflated)?;

    writer.finish().map_err(zip_err)?;
    Ok(temp_path)
}

/// recursively add every file under `base` (relative to `root`) to `writer`,
/// skipping the `mimetype` entry (already written first, above).
fn add_dir_entries(
    writer: &mut zip::ZipWriter<std::fs::File>,
    root: &Path,
    base: &Path,
    opts: zip::write::SimpleFileOptions,
) -> std::io::Result<()> {
    for entry in std::fs::read_dir(base)? {
        let path = entry?.path();
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        if rel == "mimetype" {
            continue;
        }
        if path.is_dir() {
            add_dir_entries(writer, root, &path, opts)?;
        } else {
            writer.start_file(rel, opts).map_err(zip_err)?;
            writer.write_all(&std::fs::read(&path)?)?;
        }
    }
    Ok(())
}

fn zip_err(e: zip::result::ZipError) -> std::io::Error {
    std::io::Error::other(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn write_minimal_epub_dir(dir: &Path) {
        tokio::fs::write(dir.join("mimetype"), "application/epub+zip")
            .await
            .unwrap();
        tokio::fs::create_dir_all(dir.join("META-INF"))
            .await
            .unwrap();
        tokio::fs::write(dir.join("META-INF").join("container.xml"), "<container/>")
            .await
            .unwrap();
        tokio::fs::create_dir_all(dir.join("OPS")).await.unwrap();
        tokio::fs::write(dir.join("OPS").join("chapter1.xhtml"), "<html/>")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn repairs_a_valid_exploded_epub_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let epub_dir = tmp.path().join("book.epub");
        tokio::fs::create_dir_all(&epub_dir).await.unwrap();
        write_minimal_epub_dir(&epub_dir).await;

        assert!(looks_like_epub_directory(&epub_dir));

        let zip_path = repair(&epub_dir).await.expect("repair");
        assert!(zip_path.is_file());

        let file = std::fs::File::open(&zip_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        assert_eq!(archive.by_index(0).unwrap().name(), "mimetype");
        let mut names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec!["META-INF/container.xml", "OPS/chapter1.xhtml", "mimetype"]
        );

        std::fs::remove_file(&zip_path).ok();
    }

    #[tokio::test]
    async fn rejects_a_directory_missing_epub_markers() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("not-really.epub");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::write(dir.join("readme.txt"), "hi")
            .await
            .unwrap();

        assert!(looks_like_epub_directory(&dir));
        let err = repair(&dir).await.unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    }

    #[test]
    fn does_not_flag_a_regular_epub_file() {
        let tmp = tempfile::tempdir().unwrap();
        let file_path = tmp.path().join("book.epub");
        std::fs::write(&file_path, b"PK\x03\x04fake zip bytes").unwrap();
        assert!(!looks_like_epub_directory(&file_path));
    }
}
