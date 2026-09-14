#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"

archive="landrun.tar.gz"
build_dir="landrun.build.$$"
cleanup() {
  rm -f -- "$archive"
  rm -rf -- "$build_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "SETUP SCRIPT FOR CODEFORT"
echo "-------------------------"
echo "This script is designed to assist in setting up Codefort on this system."

# Check for --assume-yes or -y flags
assume_yes=0
for arg in "$@"; do
  if [[ "$arg" == "--assume-yes" ]] || [[ "$arg" == "-y" ]]; then
    assume_yes=1
    break
  fi
done

# Skip confirmation if --assume-yes or -y flag is present
if [[ "$assume_yes" -eq 0 ]]; then
  read -r -p "Are you sure you want to proceed? [y/N] " -n 1
  echo
  if [[ !("$REPLY" =~ ^[Yy]$) ]]; then
      echo "Ending..."
      exit 1
  fi
fi

echo

# Check if needed CLI tools are available
programsAvailable=1

if ! [ -x "$(command -v bun)" ]; then
  echo 'Bun is required to run the application. Please install Bun.' >&2
  programsAvailable=0
fi
if ! [ -x "$(command -v go)" ]; then
  echo 'Go is required for the Landrun dependency to work. Please install Go.' >&2
  programsAvailable=0
fi
if ! [ -x "$(command -v curl)" ]; then
  echo 'Please install curl to use this script.' >&2
  programsAvailable=0
fi
if ! [ -x "$(command -v tar)" ]; then
  echo 'Please install tar to use this script.' >&2
  programsAvailable=0
fi

if [ "$programsAvailable" -eq "0" ]; then
   echo "^^ Install the above dependencies to continue ^^";
   exit 1;
fi

echo "Downloading Landrun..."

rm -f -- "$archive"
rm -rf -- landrun

# NOTE: Change this when new Landrun releases are published!
curl --fail --show-error --location --retry 3 --retry-delay 1 -# -o "$archive" \
  https://api.github.com/repos/Zouuup/landrun/tarball/1ea69d30e8fffe7ffa7d1b020f01f964d30ca13f

echo "Extracting Landrun..."
mkdir "$build_dir"

# `--strip-components=1` removes the "Zouuup-landrun-0abcdef" subdirectory
tar -xvzf "$archive" -C "$build_dir" --strip-components=1 >/dev/null

echo "Building Landrun..."
# in a subshell to not disturb the rest of the script
(cd "$build_dir" && go build -o landrun cmd/landrun/main.go)
mv -- "$build_dir" landrun
echo "Built!"
echo

echo "Installing Bun dependencies..."
bun --frozen-lockfile install >/dev/null
echo "Installed Bun dependencies!"
echo

echo "CODEFORT IS READY!"
echo "Just run 'bun run start' to start codefort!"
echo "If you have any concerns, please file an issue on our GitHub repository:"
echo "https://github.com/webdev03/codefort"
echo
echo "Enjoy! :D"
