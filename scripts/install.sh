#!/bin/sh

set -eu

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  printf '%s\n' "LocalHub installs only on macOS arm64 with this script." >&2
  exit 2
fi

if ! command -v bun >/dev/null 2>&1 || ! command -v bunx >/dev/null 2>&1; then
  printf '%s\n' "Bun is required. Install Bun 1.3.14 or newer, then rerun this command." >&2
  exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_dir=$(dirname -- "$script_dir")
install_dir=${LOCALHUB_INSTALL_DIR:-"$HOME/.local/bin"}

case "$install_dir" in
  "" | "/")
    printf '%s\n' "Refusing unsafe LOCALHUB_INSTALL_DIR: $install_dir" >&2
    exit 2
    ;;
esac

mkdir -p "$install_dir"
install_dir=$(CDPATH= cd -- "$install_dir" && pwd)
case "$install_dir" in
  "" | "/")
    printf '%s\n' "Refusing unsafe resolved install directory: $install_dir" >&2
    exit 2
    ;;
esac

printf '%s\n' "Building LocalHub with Bun 1.3.14..."
cd "$repository_dir"
bunx bun@1.3.14 install --frozen-lockfile
bunx bun@1.3.14 run build

temporary=$(mktemp "$install_dir/.lh.XXXXXX")
target="$install_dir/lh"
trap 'rm -f "$temporary"' 0 1 2 15

cp "$repository_dir/dist/lh" "$temporary"
chmod 755 "$temporary"
mv -f "$temporary" "$target"
trap - 0 1 2 15

"$target" --version >/dev/null
"$target" --help >/dev/null

printf '%s\n' "Installed LocalHub: $target"
case ":${PATH:-}:" in
  *":$install_dir:"*) printf '%s\n' "Run: lh doctor" ;;
  *) printf '%s\n' "Add $install_dir to PATH, then run: lh doctor" ;;
esac
