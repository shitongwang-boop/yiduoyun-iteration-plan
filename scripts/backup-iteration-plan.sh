#!/bin/sh
set -eu

repository_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
backup_date=${1:-$(date +%F)}
source_file="$repository_dir/data/iteration-plan.json"
backup_dir="$repository_dir/data/backups"
backup_file="$backup_dir/iteration-plan-$backup_date.json"

if [ ! -f "$source_file" ]; then
  echo "Missing source file: $source_file" >&2
  exit 1
fi

mkdir -p "$backup_dir"

if [ -f "$backup_file" ]; then
  echo "Backup already exists: $backup_file"
  exit 0
fi

cp "$source_file" "$backup_file"
echo "Created backup: $backup_file"
