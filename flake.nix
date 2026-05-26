{
  description = "Lumiverse development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    self,
    nixpkgs,
    flake-utils,
  }:
    flake-utils.lib.eachDefaultSystem (
      system: let
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };
      in
        {
          devShells.default = pkgs.mkShell {
            packages = with pkgs;
              [
                bun
                git
                nodejs_22
                glib
              ];
            shellHook = ''
              export LD_LIBRARY_PATH="${pkgs.gcc.cc.lib}/lib:${pkgs.glib}/lib"
            '';
        };
        }
    );
}
