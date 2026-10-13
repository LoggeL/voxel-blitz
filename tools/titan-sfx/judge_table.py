"""Markdown score tables from judge_all.py runs: python3 -I judge_table.py <round-dir> [<round-dir> ...]
Prints one row per file with the OVERALL score of every round (the last run of a file in a round wins),
then the full six-score row of the last round."""
import sys, json, pathlib
K = ['FIT', 'PUNCH', 'CLEANLINESS', 'LENGTH_TAIL', 'DISTINCTNESS', 'OVERALL']
rounds = []
for d in sys.argv[1:]:
    r = {}
    for line in (pathlib.Path(d) / 'summary.jsonl').read_text().splitlines():
        j = json.loads(line); r[j['file']] = j['scores']
    rounds.append((pathlib.Path(d).name, r))
files = sorted({f for _, r in rounds for f in r})
print('| File | ' + ' | '.join(n for n, _ in rounds) + ' | ' + ' | '.join(k.title().replace('_', '/') for k in K[:-1]) + ' |')
print('|---' * (1 + len(rounds) + len(K) - 1) + '|')
for f in files:
    ov = [str(r.get(f, {}).get('OVERALL', '')) for _, r in rounds]
    last = next((r[f] for _, r in reversed(rounds) if f in r), {})
    print(f'| `{f}` | ' + ' | '.join(ov) + ' | ' + ' | '.join(str(last.get(k, '')) for k in K[:-1]) + ' |')
