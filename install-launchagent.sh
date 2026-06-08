#!/bin/bash

# Dive launchd Service Installer for macOS
# Registers and starts the compiled standalone binary as an always-on background service.

echo "============================================="
echo "   INSTALLING DIVE BACKGROUND SERVICE"
echo "============================================="

# 1. Verify that the binary has been compiled
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
BINARY="$DIR/dist/dive"

if [ ! -f "$BINARY" ]; then
    echo "ERROR: Standalone binary not found at $BINARY"
    echo "Please build the binary first by running: ./build-sea.sh"
    exit 1
fi

# 2. Define service variables
PLIST_LABEL="com.user.dive"
LEGACY_PLIST_LABELS=("com.user.antifaz" "com.user.ollamapichat")
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
LOG_DIR="$HOME/ollama-pi-chat"
KEEP_DAEMON_LOGS="${OLLAMA_PI_CHAT_KEEP_DAEMON_LOGS:-0}"

if [ "$KEEP_DAEMON_LOGS" = "1" ]; then
    STDOUT_PATH="$LOG_DIR/daemon.log"
    STDERR_PATH="$LOG_DIR/daemon.error.log"
else
    STDOUT_PATH="/dev/null"
    STDERR_PATH="/dev/null"
fi

# 2b. Read the configured server port from pi-settings.json (fallback: 8080)
SETTINGS_FILE="$LOG_DIR/pi-settings.json"
SERVER_PORT=8080
if [ -f "$SETTINGS_FILE" ]; then
    EXTRACTED=$(node -e "
      try {
        const s = JSON.parse(require('fs').readFileSync('$SETTINGS_FILE','utf8'));
        const p = parseInt(s.serverPort, 10);
        if (!isNaN(p) && p > 0 && p < 65536) process.stdout.write(String(p));
      } catch(_) {}
    " 2>/dev/null)
    if [ -n "$EXTRACTED" ]; then
        SERVER_PORT="$EXTRACTED"
    fi
fi

# Ensure the log/data directory exists
mkdir -p "$LOG_DIR"

echo "Creating launchd configuration..."

# 3. Create the plist file
cat <<EOF > "$PLIST_PATH"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$PLIST_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$BINARY</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PORT</key>
        <string>$SERVER_PORT</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$STDOUT_PATH</string>
    <key>StandardErrorPath</key>
    <string>$STDERR_PATH</string>
    <key>WorkingDirectory</key>
    <string>$DIR</string>
</dict>
</plist>
EOF

# 4. Load and start the launchd service using the modern bootstrap/bootout API
# (launchctl load/unload were deprecated in macOS 10.10)
echo "Unregistering any existing service..."
launchctl bootout "gui/$UID/$PLIST_LABEL" 2>/dev/null || true
for LEGACY_PLIST_LABEL in "${LEGACY_PLIST_LABELS[@]}"; do
    launchctl bootout "gui/$UID/$LEGACY_PLIST_LABEL" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/$LEGACY_PLIST_LABEL.plist"
done

echo "Registering and starting the service..."
launchctl bootstrap "gui/$UID" "$PLIST_PATH"

if [ $? -eq 0 ]; then
    echo "============================================="
    echo "SUCCESS: Background service installed & running!"
    echo "The server will now start automatically whenever you log in."
    echo "It is running securely on http://127.0.0.1:${SERVER_PORT}."
    echo ""
    echo "To stop the service, run:"
    echo "  launchctl bootout gui/\$UID/$PLIST_LABEL"
    echo ""
    echo "To start the service again, run:"
    echo "  launchctl bootstrap gui/\$UID \"$PLIST_PATH\""
    echo ""
    if [ "$KEEP_DAEMON_LOGS" = "1" ]; then
        echo "Daemon logs are enabled:"
        echo "  $LOG_DIR/daemon.log"
        echo "  $LOG_DIR/daemon.error.log"
    else
        echo "Daemon logs are disabled by default to prevent unbounded log growth."
        echo "Re-run with OLLAMA_PI_CHAT_KEEP_DAEMON_LOGS=1 if you need daemon logs."
    fi
    echo "============================================="
else
    echo "ERROR: Failed to register service with launchctl."
    exit 1
fi
