#!/usr/bin/env bash
# Re-export every branding PNG from its SVG source. Needs inkscape on PATH.
set -euo pipefail
cd "$(dirname "$0")"

command -v inkscape >/dev/null || { echo "inkscape not found on PATH" >&2; exit 1; }

inkscape -w 1024 -h 1024 --export-type=png --export-filename=logo-1024.png logo.svg
inkscape -w  256 -h  256 --export-type=png --export-filename=logo-256.png  logo.svg
inkscape -w 1000 --export-type=png --export-filename=wordmark-light.png wordmark-light.svg
inkscape -w 1000 --export-type=png --export-filename=wordmark-dark.png  wordmark-dark.svg

# The marketplace icon must live outside docs/ — see .vscodeignore.
cp logo-256.png ../../resources/logo.png

echo "regenerated; lockup-*.png and social-preview.png are composed by hand, left alone"
