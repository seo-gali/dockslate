set -eu
action=$1
target=$2
case "$target" in /*) ;; *) printf 'Absolute container path required' >&2; exit 10;; esac
prefix=
old_ifs=$IFS
IFS=/
set -f
for part in $target; do
  [ -n "$part" ] || continue
  [ "$part" != . ] && [ "$part" != .. ] || exit 11
  prefix="$prefix/$part"
  if [ -L "$prefix" ]; then printf 'Symbolic link paths are not followed' >&2; exit 12; fi
done
IFS=$old_ifs
set +f
command -v stat >/dev/null 2>&1 || { printf 'Container stat command is unavailable' >&2; exit 13; }
if [ "$action" = list ]; then
  [ -d "$target" ] || { printf 'Container directory is unavailable' >&2; exit 14; }
  count=0
  for entry in "$target"/* "$target"/.[!.]* "$target"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    if [ "$count" -ge 256 ]; then printf 'truncated\000'; break; fi
    kind=other
    if [ -L "$entry" ]; then kind=symlink
    elif [ -d "$entry" ]; then kind=directory
    elif [ -f "$entry" ]; then kind=file; fi
    size=$(stat -c '%s' "$entry" 2>/dev/null) || size=
    modified=$(stat -c '%Y' "$entry" 2>/dev/null) || modified=
    printf '%s\000%s\000%s\000%s\000' "$kind" "$size" "$modified" "${entry##*/}"
    count=$((count + 1))
  done
elif [ "$action" = preview ]; then
  [ -f "$target" ] || { printf 'Only regular container files can be previewed' >&2; exit 15; }
  head -c 524289 "$target"
else
  printf 'Unsupported container file operation' >&2
  exit 16
fi
