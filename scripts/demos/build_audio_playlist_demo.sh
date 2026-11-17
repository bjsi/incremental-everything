#!/bin/sh
# Rebuilds docs/demos/audio-playlist/player.js: the real player widget, bundled with a
# mock of the RemNote SDK (audio_playlist_mock_sdk.js), for docs/demos/audio-playlist.html.
# Run it from the repository root after changing the player.
set -e
cd "$(dirname "$0")/../.."
NODE_PATH="$PWD/node_modules" npx esbuild src/widgets/audio_playlist_float.tsx \
  --bundle --minify --target=es2019 \
  --outfile=docs/demos/audio-playlist/player.js \
  --alias:@remnote/plugin-sdk="$PWD/scripts/demos/audio_playlist_mock_sdk.js" \
  --loader:.css=empty --loader:.png=dataurl --loader:.svg=dataurl \
  --define:process.env.NODE_ENV=\"production\" \
  --legal-comments=none --log-level=warning
ls -l docs/demos/audio-playlist/player.js
