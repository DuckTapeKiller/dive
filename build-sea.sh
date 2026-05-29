#!/bin/bash

# Ollama Pi Chat Standalone macOS Single Executable Application Build Script
# Requirements: Node.js 20+

echo "============================================="
echo "   BUILDING OLLAMA PI CHAT STANDALONE MAC BINARY"
echo "============================================="

# 1. Clean and create output directory
rm -rf dist
mkdir -p dist

# 2. Use Node to inline index.html content into server.js and save as dist/app.js
cp server.js dist/app.js

# 3. Create sea-config.json for compilation
echo "Generating sea-config.json..."
cat <<EOT > dist/sea-config.json
{
  "main": "dist/app.js",
  "output": "dist/sea-prep.blob",
  "disableSentinel": false,
  "assets": {
    "index.html": "index.html"
  }
}
EOT

# 4. Generate preparation blob
echo "Compiling script preparation blob..."
node --experimental-sea-config dist/sea-config.json

if [ ! -f dist/sea-prep.blob ]; then
    echo "ERROR: Failed to generate dist/sea-prep.blob"
    exit 1
fi

TARGET_ARCH=${1:-$(uname -m)}
echo "Target architecture: $TARGET_ARCH"

# 5. Copy the active Node.js executable
echo "Copying Node.js binary..."
cp "$(which node)" dist/ollama-pi-chat-fat

# Check if the binary is a universal (fat) binary and thin it if necessary
if lipo -info dist/ollama-pi-chat-fat | grep -q "Architectures in the fat file"; then
    echo "Universal binary detected. Thinning to requested architecture ($TARGET_ARCH) to resolve sentinel duplicates..."
    lipo -thin $TARGET_ARCH dist/ollama-pi-chat-fat -output dist/ollama-pi-chat
    rm dist/ollama-pi-chat-fat
else
    mv dist/ollama-pi-chat-fat dist/ollama-pi-chat
fi

# macOS signature must be removed before injection, otherwise postject fails
echo "Removing macOS codesign signature..."
codesign --remove-signature dist/ollama-pi-chat

# Dynamically find the sentinel fuse in the copied binary
echo "Detecting sentinel fuse value..."
FUSE_FULL=$(node -e 'const fs = require("fs"); const buf = fs.readFileSync("dist/ollama-pi-chat"); const m = buf.toString("binary").match(/NODE_SEA_FUSE_[a-f0-9]*:0/); console.log(m ? m[0] : "");')

if [ -z "$FUSE_FULL" ]; then
    echo "ERROR: Could not detect NODE_SEA_FUSE in the Node.js binary."
    exit 1
fi

FUSE_NAME=$(echo "$FUSE_FULL" | cut -d':' -f1)
echo "Detected fuse: $FUSE_NAME"

# 6. Inject blob into executable
echo "Injecting blob into Mach-O segment..."
npx -y postject dist/ollama-pi-chat NODE_SEA_BLOB dist/sea-prep.blob --sentinel-fuse "$FUSE_NAME" --macho-segment-name NODE_SEA

if [ $? -ne 0 ]; then
    echo "ERROR: Failed to inject blob into executable using postject."
    exit 1
fi

# 7. Ad-hoc sign the compiled binary on macOS to enable running it locally
echo "Re-signing binary with ad-hoc signature and preserved entitlements..."
codesign -d --entitlements :- "$(which node)" > dist/node.entitlements 2>/dev/null
if [ -f dist/node.entitlements ] && [ -s dist/node.entitlements ]; then
    codesign --sign - --force --entitlements dist/node.entitlements dist/ollama-pi-chat
else
    codesign --sign - dist/ollama-pi-chat
fi
# 8. Clean up intermediate build artifacts
echo "Cleaning intermediate artifacts..."
rm -f dist/sea-prep.blob dist/sea-config.json dist/app.js

echo "============================================="
echo "SUCCESS: Standalone executable created!"
echo "Location: $(pwd)/dist/ollama-pi-chat"
echo "To run, execute: ./dist/ollama-pi-chat"
echo "============================================="
