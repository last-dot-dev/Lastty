{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    rust-overlay.url = "github:oxalica/rust-overlay";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { nixpkgs, rust-overlay, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        overlays = [ (import rust-overlay) ];
        pkgs = import nixpkgs { inherit system overlays; };
        isDarwin = pkgs.stdenv.isDarwin;

        rustToolchain = pkgs.rust-bin.stable.latest.default.override {
          extensions = [ "rust-src" "rust-analyzer" ];
          targets = [];
        };

        # Linux-specific libraries (runtime)
        linuxLibraries = with pkgs; [
          webkitgtk_4_1
          gtk3
          cairo
          gdk-pixbuf
          glib
          dbus
          openssl
          librsvg
          vulkan-loader
          libxkbcommon
          wayland
          freetype
          fontconfig
          expat
        ];

        # Linux-specific build inputs
        linuxBuildInputs = with pkgs; [
          gobject-introspection
          cmake
          fontconfig
          freetype
          webkitgtk_4_1.dev
          gtk3.dev
          cairo.dev
          gdk-pixbuf.dev
          glib.dev
          dbus.dev
          openssl.dev
          librsvg.dev
          pango.dev
          atk.dev
          harfbuzz.dev
          libsoup_3.dev
        ];

        # macOS-specific build inputs
        darwinBuildInputs = with pkgs; [
          darwin.apple_sdk.frameworks.WebKit
          darwin.apple_sdk.frameworks.Security
          darwin.apple_sdk.frameworks.AppKit
        ];

        commonBuildInputs = with pkgs; [
          rustToolchain
          pkg-config
          cargo-tauri
          nodejs
          pnpm
        ];

        buildInputs = commonBuildInputs
          ++ (if isDarwin then darwinBuildInputs else linuxBuildInputs);

        libraries = if isDarwin then [] else linuxLibraries;
      in
      {
        devShells.default = pkgs.mkShell {
          inherit buildInputs;

          shellHook = if isDarwin then ''
          '' else ''
            export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath libraries}:$LD_LIBRARY_PATH"
            export XDG_DATA_DIRS="${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}:$XDG_DATA_DIRS"
            export GIO_MODULE_DIR="${pkgs.glib-networking}/lib/gio/modules/"
          '';
        };
      });
}
