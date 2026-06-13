#!/bin/bash
F='/mnt/cold/foundry-media'
GAME=/mnt/fast/apps/stacks/poker/public
OUT=$GAME/portraits
DRY=${1:-dry}
[ "$DRY" = go ] && mkdir -p $OUT

echo 'Indexing foundry token_ files by md5 (webp/png/jpg)...'
declare -A IDX
while IFS= read -r tok; do
  h=$(md5sum "$tok" | cut -d' ' -f1)
  IDX[$h]="$tok"
done < <(find "$F" \( -iname 'token_*.webp' -o -iname 'token_*.png' -o -iname 'token_*.jpg' -o -iname 'token_*.jpeg' \))
echo "indexed ${#IDX[@]} unique token hashes"

# find the best portrait for a foundry token path: exact token_-stripped sibling,
# else the same-dir non-token file with the LONGEST shared name stem.
find_portrait() {
  local tok="$1" dir tname stem
  dir=$(dirname "$tok"); tname=$(basename "$tok"); stem="${tname#token_}"; stem="${stem%.*}"
  local ext
  for ext in webp png jpg jpeg; do
    [ -f "$dir/$stem.$ext" ] && { echo "$dir/$stem.$ext"; return; }
  done
  # fuzzy: longest non-token file in the dir whose stem is a prefix of, or contains, our stem
  local best='' bestlen=0 f fb fstem
  for f in "$dir"/*.webp "$dir"/*.png "$dir"/*.jpg; do
    [ -f "$f" ] || continue
    fb=$(basename "$f"); case "$fb" in token_*) continue;; esac
    fstem="${fb%.*}"
    # require a decent shared prefix (>=12 chars) to avoid bad matches
    local common=0 i c1 c2
    while [ $common -lt ${#fstem} ] && [ $common -lt ${#stem} ]; do
      c1="${fstem:$common:1}"; c2="${stem:$common:1}"; [ "$c1" = "$c2" ] || break; common=$((common+1))
    done
    if [ $common -ge 12 ] && [ $common -gt $bestlen ]; then best="$f"; bestlen=$common; fi
  done
  [ -n "$best" ] && echo "$best"
}

matched=0; nopair=0; noportrait=0
> /tmp/pair_nopair.txt; > /tmp/pair_noportrait.txt; > /tmp/pair_ok.txt
for src in $GAME/dungeon/monsters/* $GAME/tokens/*; do
  case "$src" in *.webp|*.png) ;; *) continue;; esac
  base=$(basename "$src")
  h=$(md5sum "$src" | cut -d' ' -f1)
  tok="${IDX[$h]}"
  if [ -z "$tok" ]; then nopair=$((nopair+1)); echo "$base" >> /tmp/pair_nopair.txt; continue; fi
  portrait=$(find_portrait "$tok")
  if [ -z "$portrait" ]; then noportrait=$((noportrait+1)); echo "$base <- $(basename "$tok")" >> /tmp/pair_noportrait.txt; continue; fi
  matched=$((matched+1)); echo "$base <- $(basename "$portrait")" >> /tmp/pair_ok.txt
  if [ "$DRY" = go ]; then obase="${base%.*}.webp"; cp "$portrait" "$OUT/$obase"; chown tobias:tobias "$OUT/$obase" 2>/dev/null; fi
done
echo "=== matched=$matched  nopair=$nopair  noportrait=$noportrait ==="
