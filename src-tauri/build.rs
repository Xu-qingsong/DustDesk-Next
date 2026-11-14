fn main() {
    // The icon lives outside the Cargo package, so asset-only replacements
    // must also rebuild the Windows executable resources.
    println!("cargo:rerun-if-changed=../Assets/DustDesk.ico");
    tauri_build::build();
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        // Standalone Windows LAN dialog fixtures need the same v6 common
        // controls activation as the application; no runtime manifest files.
        println!("cargo:rustc-link-arg-examples=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg-examples=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
    }
}
