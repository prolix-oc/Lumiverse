{
  description = "Lumiverse development shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { nixpkgs, ... }:
    let
      lib = nixpkgs.lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forEachSystem = lib.genAttrs systems;
    in {
      devShells = forEachSystem (system:
        let
          pkgs = import nixpkgs { inherit system; };

          runtimeLibs = with pkgs; [
            openssl
            sqlite
            stdenv.cc.cc.lib
            vips
            zlib
          ]
          ++ lib.optionals pkgs.stdenv.isLinux [
            glibc
          ]
          ++ lib.optionals pkgs.stdenv.isDarwin [
            libiconv
          ];

          toolchain = with pkgs; [
            bun
            curl
            ffmpeg
            git
            gnumake
            nodejs
            pkg-config
            python3
            sqlite
          ]
          ++ lib.optionals pkgs.stdenv.isLinux [
            gcc
          ]
          ++ lib.optionals pkgs.stdenv.isDarwin [
            clang
          ];

          libraryPath = lib.makeLibraryPath runtimeLibs;
        in {
          default = pkgs.mkShell {
            packages = toolchain ++ runtimeLibs;

            LD_LIBRARY_PATH = lib.optionalString pkgs.stdenv.isLinux libraryPath;
            DYLD_LIBRARY_PATH = lib.optionalString pkgs.stdenv.isDarwin libraryPath;
            NIX_LD_LIBRARY_PATH = lib.optionalString pkgs.stdenv.isLinux libraryPath;

            shellHook = ''
              export PATH="$PWD/node_modules/.bin:$PWD/frontend/node_modules/.bin:$PATH"
              echo "Lumiverse Nix shell ready."
              echo "Run ./start.sh for the guided setup, or bun run dev for backend-only work."
            '';
          };
        });
    };
}
