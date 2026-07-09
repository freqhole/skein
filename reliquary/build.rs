// sets DATABASE_URL for sqlx's compile-time query!/query_as! macros against
// a real, migrated sqlite dev db (see dev-data/README or the reliquary crate
// docs for how to reproduce it). computed from CARGO_MANIFEST_DIR - always
// this crate's own directory, regardless of the directory `cargo` is
// invoked from - so builds are correct no matter the invocation cwd or which
// machine they run on, with no hardcoded absolute path committed anywhere.
fn main() {
    let manifest_dir =
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by cargo");
    println!("cargo:rustc-env=DATABASE_URL=sqlite:{manifest_dir}/dev-data/skein-hub.db");
    println!("cargo:rerun-if-changed=build.rs");
}
