#!/usr/bin/env bash
set -e

# Build frontend
cd realtime-chat-frontend
npm install
npm run build

# Return to root and install backend deps
echo "\nBuilding backend dependencies..."
cd ..
npm install

echo "\nBuild complete."
