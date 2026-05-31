#!/bin/bash

# Ollama Pi Chat Launcher for macOS

echo "============================================="
echo "     OLLAMA PI CHAT LOCAL LAUNCHER"
echo "============================================="

# 1. Check Node.js
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js is not installed!"
    echo "Please install Node.js (version 20+) to run this application."
    exit 1
fi

# 1b. Check node_modules — install if missing
if [ ! -d "$DIR/node_modules" ]; then
    echo "Dependencies not found. Running npm install..."
    cd "$DIR" && npm install
    if [ $? -ne 0 ]; then
        echo "ERROR: npm install failed. Please check your network connection and try again."
        exit 1
    fi
fi


# 2. Check Ollama running locally (Warning only)
curl -s -m 2 http://localhost:11434 &> /dev/null
if [ $? -ne 0 ]; then
    echo "WARNING: Local Ollama is not running (checked http://localhost:11434)"
    echo "Make sure Ollama is launched if you plan to use Ollama models."
fi

# Get current script folder directory
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Start Node server
echo "Starting local Node.js server..."
node "$DIR/server.js" &
SERVER_PID=$!

# Trap Ctrl+C to kill the server when exiting
cleanup() {
    echo ""
    echo "Stopping server..."
    kill $SERVER_PID
    exit 0
}
trap cleanup SIGINT SIGTERM

# Wait 1s for server to start, then open the browser
sleep 1
echo "Opening browser at http://127.0.0.1:8080..."
open "http://127.0.0.1:8080"

# Keep script running
wait $SERVER_PID
