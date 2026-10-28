#!/usr/bin/env python3
"""Token report for the revamp (roadmap 5.1a).

Reads Claude Code's local session logs and prints tokens by model and by
worktree since a given time. Run it on each machine:

    python3 plans/tools/token-report.py --since "2026-10-29 08:00" [--match aplos-mail]
"""

import argparse
import collections
import glob
import json
import os
import time

LOG_ROOT = os.path.expanduser("~/.claude/projects")
BIG_CONTEXT = 150_000


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--since", default=time.strftime("%Y-%m-%d 00:00"))
    parser.add_argument("--match", default="aplos-mail")
    return parser.parse_args()


def iter_usage(since_epoch, match):
    seen = set()
    for path in glob.glob(f"{LOG_ROOT}/**/*.jsonl", recursive=True):
        if match not in path or os.path.getmtime(path) < since_epoch:
            continue
        folder = path[len(LOG_ROOT) + 1 :].split("/")[0]
        yield from read_file(path, folder, seen)


def read_file(path, folder, seen):
    with open(path, errors="ignore") as handle:
        for line in handle:
            record = parse_line(line)
            message = record.get("message") or {}
            usage = message.get("usage")
            if not usage or message.get("id") in seen:
                continue
            seen.add(message.get("id"))
            yield folder, message.get("model", "?"), usage


def parse_line(line):
    try:
        return json.loads(line)
    except ValueError:
        return {}


def context_of(usage):
    return (
        usage.get("input_tokens", 0)
        + usage.get("cache_creation_input_tokens", 0)
        + usage.get("cache_read_input_tokens", 0)
    )


def summarize(rows):
    by_model = collections.defaultdict(lambda: [0, 0, 0])
    by_folder = collections.defaultdict(lambda: [0, 0, 0])
    for folder, model, usage in rows:
        context = context_of(usage)
        for table, key in ((by_model, model), (by_folder, folder)):
            table[key][0] += 1
            table[key][1] += context
            table[key][2] += 1 if context > BIG_CONTEXT else 0
    return by_model, by_folder


def print_table(title, table):
    total_calls = sum(row[0] for row in table.values()) or 1
    print(f"\n{title}: calls, share, avg context, calls over {BIG_CONTEXT // 1000}k, tokens read")
    for key, (calls, context, big) in sorted(table.items(), key=lambda item: -item[1][1]):
        share = 100 * calls / total_calls
        print(f"  {key[-55:]:55} {calls:6} {share:5.1f}% {context // max(calls, 1):8} {big:6} {context / 1e6:8.1f}M")


def main():
    args = parse_args()
    since_epoch = time.mktime(time.strptime(args.since, "%Y-%m-%d %H:%M"))
    by_model, by_folder = summarize(iter_usage(since_epoch, args.match))
    print(f"Since {args.since} (local), logs matching '{args.match}'")
    print_table("By model", by_model)
    print_table("By worktree", by_folder)


if __name__ == "__main__":
    main()
