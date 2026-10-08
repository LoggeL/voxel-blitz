#!/bin/bash
# usage: yt_search.sh "<query>" [n]  -> CC-filtered YouTube search, then per-video license verification
q=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote_plus(sys.argv[1]))" "$1")
n=${2:-8}
yt-dlp --flat-playlist --playlist-end "$n" --print "%(id)s" "https://www.youtube.com/results?search_query=${q}&sp=EgIwAQ%253D%253D" 2>/dev/null | while read id; do
  yt-dlp --skip-download --no-warnings --print "%(id)s|%(license)s|%(duration)s|%(channel)s|%(title)s" "https://www.youtube.com/watch?v=$id" 2>/dev/null
done
