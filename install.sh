#!/bin/sh

set -eu

REPOSITORY="ukibbb/buliV2"
VERSION="${BULI_VERSION:-${1:-latest}}"
PREFIX="${BULI_INSTALL_PREFIX:-$HOME/.local}"

fail() {
    printf 'buli installer: %s\n' "$*" >&2
    exit 1
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

case "$PREFIX" in
    *"'"* | *"
"*) fail "install prefix cannot contain a single quote or newline" ;;
esac

system_name="$(uname -s)"
machine_name="$(uname -m)"

case "$system_name" in
    Darwin) platform="darwin" ;;
    Linux) platform="linux" ;;
    *) fail "unsupported operating system: $system_name" ;;
esac

case "$machine_name" in
    arm64 | aarch64) architecture="arm64" ;;
    x86_64 | amd64) architecture="x64" ;;
    *) fail "unsupported architecture: $machine_name" ;;
esac

target="${platform}-${architecture}"
asset="buli-${target}.tar.gz"
if [ "$VERSION" = "latest" ]; then
    release_url="https://github.com/${REPOSITORY}/releases/latest/download"
else
    case "$VERSION" in
        v*) ;;
        *) fail "version must start with v, got: $VERSION" ;;
    esac
    release_url="https://github.com/${REPOSITORY}/releases/download/${VERSION}"
fi

for command_name in curl tar mktemp awk grep chmod cp mv mkdir rm dirname; do
    require_command "$command_name"
done

if command -v sha256sum >/dev/null 2>&1; then
    checksum_command="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
    checksum_command="shasum"
else
    fail "sha256sum or shasum is required"
fi

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/buli-install.XXXXXX")"
stage_directory=""
cleanup() {
    rm -rf "$temporary_directory"
    if [ -n "$stage_directory" ]; then rm -rf "$stage_directory"; fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

archive_path="$temporary_directory/$asset"
checksum_path="$temporary_directory/${asset}.sha256"
curl --fail --location --silent --show-error \
    "$release_url/$asset" --output "$archive_path"
curl --fail --location --silent --show-error \
    "$release_url/${asset}.sha256" --output "$checksum_path"

expected_checksum="$(awk 'NR == 1 { print $1 }' "$checksum_path")"
printf '%s\n' "$expected_checksum" | grep -Eq '^[0-9A-Fa-f]{64}$' \
    || fail "release checksum has an invalid format"
if [ "$checksum_command" = "sha256sum" ]; then
    actual_checksum="$(sha256sum "$archive_path" | awk '{ print $1 }')"
else
    actual_checksum="$(shasum -a 256 "$archive_path" | awk '{ print $1 }')"
fi
[ "$actual_checksum" = "$expected_checksum" ] \
    || fail "checksum verification failed for $asset"

extraction_directory="$temporary_directory/extracted"
mkdir -p "$extraction_directory"
tar --extract --gzip --file "$archive_path" --directory "$extraction_directory"
bundle_directory="$extraction_directory/buli-$target"
[ -x "$bundle_directory/bin/buli" ] || fail "bundle does not contain executable bin/buli"
[ -x "$bundle_directory/lib/buli/rg" ] || fail "bundle does not contain executable lib/buli/rg"
[ -f "$bundle_directory/THIRD_PARTY_LICENSES" ] \
    || fail "bundle does not contain THIRD_PARTY_LICENSES"
bundle_version="1"
if [ -f "$bundle_directory/BUNDLE_VERSION" ]; then
    bundle_version="$(awk 'NR == 1 { print $1 }' "$bundle_directory/BUNDLE_VERSION")"
    [ "$bundle_version" = "2" ] || fail "unsupported bundle version: $bundle_version"
fi
bundle_has_fd="false"
if [ -x "$bundle_directory/lib/buli/fd" ]; then
    bundle_has_fd="true"
elif [ "$bundle_version" = "2" ]; then
    fail "bundle does not contain executable lib/buli/fd"
fi

stage_directory="$PREFIX/.buli-install-$$"
rm -rf "$stage_directory"
mkdir -p "$stage_directory/bin" "$stage_directory/lib/buli" "$stage_directory/share/buli"
cp "$bundle_directory/bin/buli" "$stage_directory/bin/buli"
cp "$bundle_directory/lib/buli/rg" "$stage_directory/lib/buli/rg"
if [ "$bundle_has_fd" = "true" ]; then
    cp "$bundle_directory/lib/buli/fd" "$stage_directory/lib/buli/fd"
fi
cp "$bundle_directory/THIRD_PARTY_LICENSES" \
    "$stage_directory/share/buli/THIRD_PARTY_LICENSES"
chmod 755 "$stage_directory/bin/buli" "$stage_directory/lib/buli/rg"
if [ "$bundle_has_fd" = "true" ]; then
    chmod 755 "$stage_directory/lib/buli/fd"
fi

"$stage_directory/bin/buli" --help >/dev/null
"$stage_directory/lib/buli/rg" --version >/dev/null
if [ "$bundle_has_fd" = "true" ]; then
    "$stage_directory/lib/buli/fd" --version >/dev/null
fi

mkdir -p "$PREFIX/bin" "$PREFIX/lib/buli" "$PREFIX/share/buli"
mv "$stage_directory/lib/buli/rg" "$PREFIX/lib/buli/rg"
if [ "$bundle_has_fd" = "true" ]; then
    mv "$stage_directory/lib/buli/fd" "$PREFIX/lib/buli/fd"
else
    rm -f "$PREFIX/lib/buli/fd"
fi
mv "$stage_directory/share/buli/THIRD_PARTY_LICENSES" \
    "$PREFIX/share/buli/THIRD_PARTY_LICENSES"
mv "$stage_directory/bin/buli" "$PREFIX/bin/buli"
rm -rf "$stage_directory"
stage_directory=""

path_updated="false"
shell_config=""
if [ "${BULI_NO_MODIFY_PATH:-0}" != "1" ]; then
    case "${SHELL:-}" in
        */zsh) shell_config="$HOME/.zshrc" ;;
        */bash)
            if [ "$platform" = "darwin" ]; then
                shell_config="$HOME/.bash_profile"
            else
                shell_config="$HOME/.bashrc"
            fi
            ;;
        */sh) shell_config="$HOME/.profile" ;;
        */fish) shell_config="$HOME/.config/fish/config.fish" ;;
    esac
fi

if [ -n "$shell_config" ]; then
    mkdir -p "$(dirname "$shell_config")"
    if [ "${SHELL##*/}" = "fish" ]; then
        path_line="fish_add_path '$PREFIX/bin'"
    else
        path_line="export PATH='$PREFIX/bin':\"\$PATH\""
    fi
    if [ ! -f "$shell_config" ] || ! grep -Fqx "$path_line" "$shell_config"; then
        printf '\n# Added by the Buli installer\n%s\n' "$path_line" >> "$shell_config"
        path_updated="true"
    fi
fi

printf 'Buli %s installed to %s/bin/buli\n' "$VERSION" "$PREFIX"
if [ "$path_updated" = "true" ]; then
    printf 'PATH was updated in %s. Open a new terminal before running buli.\n' \
        "$shell_config"
elif [ -z "$shell_config" ] && [ "${BULI_NO_MODIFY_PATH:-0}" != "1" ]; then
    printf 'Add %s/bin to PATH before running buli.\n' "$PREFIX"
elif command -v buli >/dev/null 2>&1; then
    printf 'Run: buli\n'
else
    printf 'Run now: %s/bin/buli\n' "$PREFIX"
fi
