#!/bin/bash

# Dive Standalone macOS Single Executable Application Build Script
# Requirements: Node.js 20+

echo "============================================="
echo "   BUILDING DIVE STANDALONE MAC BINARY"
echo "============================================="

# 1. Clean and create output directory
rm -rf dist
mkdir -p dist

ESBUILD_BIN="$PWD/node_modules/.bin/esbuild"
POSTJECT_BIN="$PWD/node_modules/.bin/postject"

if [ ! -x "$ESBUILD_BIN" ] || [ ! -x "$POSTJECT_BIN" ]; then
    echo "ERROR: Build dependencies are missing. Run: npm install"
    exit 1
fi

find_sea_node() {
    local candidates=()
    if [ -n "$NODE_SEA_BINARY" ]; then
        candidates+=("$NODE_SEA_BINARY")
    fi
    if command -v node >/dev/null 2>&1; then
        candidates+=("$(command -v node)")
    fi
    candidates+=("/usr/local/bin/node" "/opt/homebrew/bin/node")

    local seen=""
    local candidate
    for candidate in "${candidates[@]}"; do
        [ -x "$candidate" ] || continue
        case ":$seen:" in
            *":$candidate:"*) continue ;;
        esac
        seen="$seen:$candidate"
        if grep -a -q 'NODE_SEA_FUSE_[a-f0-9]*:0' "$candidate"; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done

    return 1
}

SEA_NODE="$(find_sea_node)" || {
    echo "ERROR: Could not find a SEA-compatible Node.js binary with NODE_SEA_FUSE."
    echo "Install the official Node.js macOS build or set NODE_SEA_BINARY=/path/to/node."
    exit 1
}
echo "Using SEA Node: $SEA_NODE"

# 2. Bundle the Node server and local modules into a single SEA entrypoint.
echo "Bundling server for standalone runtime..."
"$ESBUILD_BIN" server.js \
    --bundle \
    --platform=node \
    --format=cjs \
    --outfile=dist/app.js \
    --log-level=warning

if [ ! -f dist/app.js ]; then
    echo "ERROR: Failed to generate bundled dist/app.js"
    exit 1
fi

# 3. Create sea-config.json for compilation
echo "Generating sea-config.json..."
cat <<EOT > dist/sea-config.json
{
  "main": "dist/app.js",
  "output": "dist/sea-prep.blob",
  "disableSentinel": false,
  "assets": {
    "index.html": "index.html",
    "font_faces.css": "font_faces.css",
    "package.json": "package.json",
    "prompts.json": "prompts.json",
    "library/config.default.json": "library/config.default.json",
    "library/schema.sql": "library/schema.sql",
    "vendor/marked.umd.js": "node_modules/marked/lib/marked.umd.js",
    "vendor/purify.min.js": "node_modules/dompurify/dist/purify.min.js"
  }
}
EOT

# 4. Generate preparation blob
echo "Compiling script preparation blob..."
"$SEA_NODE" --experimental-sea-config dist/sea-config.json

if [ ! -f dist/sea-prep.blob ]; then
    echo "ERROR: Failed to generate dist/sea-prep.blob"
    exit 1
fi

TARGET_ARCH=${1:-$(uname -m)}
echo "Target architecture: $TARGET_ARCH"

# 5. Copy the active Node.js executable
echo "Copying Node.js binary..."
cp "$SEA_NODE" dist/dive-fat

# Check if the binary is a universal (fat) binary and thin it if necessary
if lipo -info dist/dive-fat | grep -q "Architectures in the fat file"; then
    echo "Universal binary detected. Thinning to requested architecture ($TARGET_ARCH) to resolve sentinel duplicates..."
    lipo -thin $TARGET_ARCH dist/dive-fat -output dist/dive
    rm dist/dive-fat
else
    mv dist/dive-fat dist/dive
fi

# macOS signature must be removed before injection, otherwise postject fails
echo "Removing macOS codesign signature..."
codesign --remove-signature dist/dive 2>/dev/null || true

# Dynamically find the sentinel fuse in the copied binary
echo "Detecting sentinel fuse value..."
FUSE_FULL=$("$SEA_NODE" -e 'const fs = require("fs"); const buf = fs.readFileSync("dist/dive"); const m = buf.toString("binary").match(/NODE_SEA_FUSE_[a-f0-9]*:0/); console.log(m ? m[0] : "");')

if [ -z "$FUSE_FULL" ]; then
    echo "ERROR: Could not detect NODE_SEA_FUSE in the Node.js binary."
    exit 1
fi

FUSE_NAME=$(echo "$FUSE_FULL" | cut -d':' -f1)
echo "Detected fuse: $FUSE_NAME"

# 6. Inject blob into executable
echo "Injecting blob into Mach-O segment..."
"$POSTJECT_BIN" dist/dive NODE_SEA_BLOB dist/sea-prep.blob --sentinel-fuse "$FUSE_NAME" --macho-segment-name NODE_SEA

if [ $? -ne 0 ]; then
    echo "ERROR: Failed to inject blob into executable using postject."
    exit 1
fi

# 7. Ad-hoc sign the compiled binary on macOS to enable running it locally
echo "Re-signing binary with ad-hoc signature and preserved entitlements..."
codesign -d --entitlements :- "$SEA_NODE" > dist/node.entitlements 2>/dev/null
if [ -f dist/node.entitlements ] && [ -s dist/node.entitlements ]; then
    codesign --sign - --force --entitlements dist/node.entitlements dist/dive
else
    codesign --sign - dist/dive
fi
# 8. Clean up intermediate build artifacts
echo "Cleaning intermediate artifacts..."
rm -f dist/sea-prep.blob dist/sea-config.json dist/app.js dist/node.entitlements

echo "============================================="
echo "SUCCESS: Standalone executable created!"
echo "Location: $(pwd)/dist/dive"
echo "To run, execute: ./dist/dive"
echo "============================================="
