#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 YYYY-MM-DD" >&2
  exit 1
fi

repository_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
backup_file="$repository_dir/data/backups/iteration-plan-$1.json"
target_file="$repository_dir/data/iteration-plan.json"

if [ ! -f "$backup_file" ]; then
  echo "Backup not found: $backup_file" >&2
  exit 1
fi

cp "$backup_file" "$target_file"
echo "Restored backup from: $backup_file"
