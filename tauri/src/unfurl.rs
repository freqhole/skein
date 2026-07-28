//! link widget unfurl — fetch a URL server-side and extract a small
//! opengraph-ish summary (title, description, preview image) for the
//! "link" widget's unfurl toggle.
//!
//! desktop-only: this is what makes real unfurling possible in tauri mode —
//! there's no CORS restriction on a native HTTP client. browser mode
//! attempts a plain `fetch()` instead (see loam/src/widgets/link-unfurl.ts's
//! `fetchUnfurl()`), which fails for most cross-origin sites; that's an
//! accepted v1 limitation, not something this module needs to work around.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::commands::DispatchError;

#[derive(Debug, Deserialize)]
pub(crate) struct LinkUnfurlArgs {
    url: String,
}

/// fetch a URL's HTML and extract a small opengraph-ish summary (title,
/// description, preview image).
///
/// any of `title`/`description`/`image_url` may be `null` in the response if
/// the page doesn't advertise that tag — that's a valid, non-error result.
pub(crate) async fn link_unfurl(args: LinkUnfurlArgs) -> Result<Value, DispatchError> {
    let response = reqwest::get(&args.url)
        .await
        .map_err(|e| DispatchError::Fetch(e.to_string()))?;
    if !response.status().is_success() {
        return Err(DispatchError::Fetch(format!(
            "http {} for {}",
            response.status(),
            args.url
        )));
    }
    let html = response
        .text()
        .await
        .map_err(|e| DispatchError::Fetch(e.to_string()))?;

    let meta = extract_link_meta(&html);
    Ok(json!({
        "title": meta.title,
        "description": meta.description,
        "image_url": meta.image_url,
    }))
}

/// parsed opengraph-ish metadata extracted from an HTML document.
#[derive(Debug, Default, PartialEq, Eq)]
struct LinkMeta {
    title: Option<String>,
    description: Option<String>,
    image_url: Option<String>,
}

/// scan an HTML document for `<title>`, `og:title`, `og:description`
/// (falling back to `<meta name="description">`), and `og:image`.
///
/// deliberately a simple string/attribute scanner rather than a full HTML
/// parser — good enough for pulling a handful of well-known tags out of
/// arbitrary third-party pages, and tolerant of attribute-order variation
/// (each `<meta ...>` tag's attributes are parsed into a map rather than
/// assuming `property` always comes before `content`). mirrors the
/// TypeScript reference implementation in
/// loam/src/widgets/link-unfurl.ts's `parseHtmlMeta()` — keep the two in
/// sync if either changes.
fn extract_link_meta(html: &str) -> LinkMeta {
    let mut meta = LinkMeta {
        title: extract_tag_text(html, "title"),
        ..Default::default()
    };
    let mut plain_description: Option<String> = None;

    for tag in find_tag_slices(html, "meta") {
        let attrs = parse_attrs(tag);
        let key = attrs
            .get("property")
            .or_else(|| attrs.get("name"))
            .map(String::as_str);
        let Some(content) = attrs.get("content") else {
            continue;
        };
        match key {
            Some("og:title") => meta.title = Some(decode_entities(content)),
            Some("og:description") => meta.description = Some(decode_entities(content)),
            Some("description") => plain_description = Some(decode_entities(content)),
            Some("og:image") | Some("og:image:url") if meta.image_url.is_none() => {
                meta.image_url = Some(decode_entities(content));
            }
            _ => {}
        }
    }

    if meta.description.is_none() {
        meta.description = plain_description;
    }
    meta
}

/// decode HTML entities likely to show up in a title or meta description:
/// numeric references (`&#38;`, `&#x26;`) and a handful of named ones.
/// `&amp;` is decoded last so `&amp;lt;` round-trips to `&lt;` rather than
/// being double-unescaped into `<`.
fn decode_entities(s: &str) -> String {
    let s = decode_numeric_entities(s);
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&nbsp;", "\u{00a0}")
        .replace("&mdash;", "\u{2014}")
        .replace("&ndash;", "\u{2013}")
        .replace("&hellip;", "\u{2026}")
        .replace("&amp;", "&")
        .trim()
        .to_string()
}

/// decode `&#NNN;` (decimal) and `&#xHHH;` (hex) numeric character
/// references. malformed references (no terminating `;`, out-of-range or
/// invalid code points) are left untouched rather than dropped.
///
/// operates on `char`s (not bytes) so multi-byte UTF-8 text is copied
/// through unchanged rather than being reinterpreted byte-by-byte.
fn decode_numeric_entities(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '&' && chars.get(i + 1) == Some(&'#') {
            let is_hex = chars.get(i + 2).is_some_and(|&c| c == 'x' || c == 'X');
            let digits_start = i + if is_hex { 3 } else { 2 };
            let mut j = digits_start;
            while chars.get(j).is_some_and(|c| c.is_ascii_hexdigit()) {
                j += 1;
            }
            if j > digits_start && chars.get(j) == Some(&';') {
                let digits: String = chars[digits_start..j].iter().collect();
                let code_point = if is_hex {
                    u32::from_str_radix(&digits, 16).ok()
                } else {
                    digits.parse::<u32>().ok()
                };
                if let Some(ch) = code_point.and_then(char::from_u32) {
                    out.push(ch);
                    i = j + 1;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// find the byte index of the `>` that closes a tag opened at `start`,
/// honoring quoted attribute values (so a `>` inside `content="a > b"`
/// doesn't end the tag early).
fn find_tag_close(s: &str) -> Option<usize> {
    let bytes = s.as_bytes();
    let mut in_quote: Option<u8> = None;
    for (i, &b) in bytes.iter().enumerate() {
        match in_quote {
            Some(q) => {
                if b == q {
                    in_quote = None;
                }
            }
            None => {
                if b == b'"' || b == b'\'' {
                    in_quote = Some(b);
                } else if b == b'>' {
                    return Some(i);
                }
            }
        }
    }
    None
}

/// find every `<tag_lower ...>` opening-tag slice in `html` (case-insensitive
/// tag name match, original casing preserved in the returned slices).
fn find_tag_slices<'a>(html: &'a str, tag_lower: &str) -> Vec<&'a str> {
    let html_lower = html.to_ascii_lowercase();
    let needle = format!("<{tag_lower}");
    let mut slices = Vec::new();
    let mut search_from = 0usize;

    while let Some(rel_start) = html_lower[search_from..].find(&needle) {
        let start = search_from + rel_start;
        let after = start + needle.len();
        // require a real tag boundary after the name so e.g. "<metabolic"
        // isn't mistaken for a "<meta" tag.
        let boundary_ok = html_lower.as_bytes().get(after).is_none_or(|&b| {
            b == b' ' || b == b'\t' || b == b'\n' || b == b'\r' || b == b'/' || b == b'>'
        });
        if !boundary_ok {
            search_from = after;
            continue;
        }
        match find_tag_close(&html[start..]) {
            Some(end_rel) => {
                let end = start + end_rel + 1; // include the closing '>'
                slices.push(&html[start..end]);
                search_from = end;
            }
            None => break,
        }
    }
    slices
}

/// parse `name="value"` / `name='value'` attribute pairs out of a single
/// opening-tag slice, order-independent. attribute names are lowercased;
/// values keep their original casing.
fn parse_attrs(tag: &str) -> std::collections::HashMap<String, String> {
    let mut attrs = std::collections::HashMap::new();
    let bytes = tag.as_bytes();
    let mut i = 0usize;

    // skip the leading "<tagname" token
    while i < bytes.len() && !bytes[i].is_ascii_whitespace() {
        i += 1;
    }

    while i < bytes.len() {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] == b'>' || bytes[i] == b'/' {
            break;
        }

        let name_start = i;
        while i < bytes.len()
            && bytes[i] != b'='
            && !bytes[i].is_ascii_whitespace()
            && bytes[i] != b'>'
        {
            i += 1;
        }
        let name = tag[name_start..i].to_ascii_lowercase();

        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }

        if i < bytes.len() && bytes[i] == b'=' {
            i += 1;
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            if i < bytes.len() && (bytes[i] == b'"' || bytes[i] == b'\'') {
                let quote = bytes[i];
                i += 1;
                let val_start = i;
                while i < bytes.len() && bytes[i] != quote {
                    i += 1;
                }
                let value = tag.get(val_start..i).unwrap_or("").to_string();
                if i < bytes.len() {
                    i += 1; // skip closing quote
                }
                if !name.is_empty() {
                    attrs.insert(name, value);
                }
            } else {
                // unquoted value (rare) — read until whitespace or '>'
                let val_start = i;
                while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'>' {
                    i += 1;
                }
                let value = tag[val_start..i].to_string();
                if !name.is_empty() {
                    attrs.insert(name, value);
                }
            }
        } else if !name.is_empty() {
            // boolean attribute with no value
            attrs.insert(name, String::new());
        }
    }
    attrs
}

/// extract the text content of the first `<tag_lower>...</tag_lower>`
/// occurrence (e.g. `<title>`). returns `None` if the tag is missing or empty.
fn extract_tag_text(html: &str, tag_lower: &str) -> Option<String> {
    let html_lower = html.to_ascii_lowercase();
    let start_pos = html_lower.find(&format!("<{tag_lower}"))?;
    let open_end = start_pos + html_lower[start_pos..].find('>')? + 1;
    let close_start_rel = html_lower[open_end..].find(&format!("</{tag_lower}"))?;
    let close_start = open_end + close_start_rel;
    let text = decode_entities(html.get(open_end..close_start)?);
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

#[cfg(test)]
mod link_unfurl_tests {
    use super::*;

    #[test]
    fn extract_link_meta_full_og_tags_normal_order() {
        let html = r#"<html><head>
            <title>fallback title</title>
            <meta property="og:title" content="og title here">
            <meta property="og:description" content="a great description">
            <meta property="og:image" content="https://example.com/preview.png">
        </head></html>"#;
        let meta = extract_link_meta(html);
        assert_eq!(meta.title.as_deref(), Some("og title here"));
        assert_eq!(meta.description.as_deref(), Some("a great description"));
        assert_eq!(
            meta.image_url.as_deref(),
            Some("https://example.com/preview.png")
        );
    }

    #[test]
    fn extract_link_meta_falls_back_without_og_tags() {
        let html = r#"<html><head>
            <title>plain title</title>
            <meta name="description" content="plain description">
        </head></html>"#;
        let meta = extract_link_meta(html);
        assert_eq!(meta.title.as_deref(), Some("plain title"));
        assert_eq!(meta.description.as_deref(), Some("plain description"));
        assert_eq!(meta.image_url, None);
    }

    #[test]
    fn extract_link_meta_tolerates_attribute_order_variation() {
        let html = r#"<meta content="reordered description" property="og:description" />"#;
        let meta = extract_link_meta(html);
        assert_eq!(meta.description.as_deref(), Some("reordered description"));
    }

    #[test]
    fn extract_link_meta_handles_single_quotes_and_missing_title() {
        let html = "<meta property='og:image' content='https://example.com/img.jpg'>";
        let meta = extract_link_meta(html);
        assert_eq!(meta.title, None);
        assert_eq!(
            meta.image_url.as_deref(),
            Some("https://example.com/img.jpg")
        );
    }

    #[test]
    fn extract_link_meta_decodes_entities_without_double_decoding_amp() {
        let html = r#"<title>Tom &amp; Jerry &lt;classic&gt;</title>"#;
        let meta = extract_link_meta(html);
        assert_eq!(meta.title.as_deref(), Some("Tom & Jerry <classic>"));
    }

    #[test]
    fn extract_link_meta_decodes_numeric_entities() {
        let html = r#"<title>Tom &#38; Jerry &#x26; friends</title>"#;
        let meta = extract_link_meta(html);
        assert_eq!(meta.title.as_deref(), Some("Tom & Jerry & friends"));
    }

    #[test]
    fn extract_link_meta_leaves_malformed_numeric_entities_untouched() {
        let html = r#"<title>no semicolon &#38 here</title>"#;
        let meta = extract_link_meta(html);
        assert_eq!(meta.title.as_deref(), Some("no semicolon &#38 here"));
    }

    #[test]
    fn extract_link_meta_handles_malformed_partial_tags() {
        let html = r#"<meta property="og:title"><meta content="no key here">"#;
        let meta = extract_link_meta(html);
        assert_eq!(meta, LinkMeta::default());
    }

    #[test]
    fn extract_link_meta_empty_document() {
        let meta = extract_link_meta("<html><body>hello</body></html>");
        assert_eq!(meta, LinkMeta::default());
    }
}
