"""Dependency-free day-block bootstrap of exported fills; no alpha claims from synthetic data."""
import argparse, json, random, statistics
from collections import defaultdict

def evaluate(fills, iterations=10000):
    daily=defaultdict(float)
    unresolved=0
    for f in fills:
        if f.get('pnl') is None:
            unresolved+=1
            continue
        daily[int(f.get('settled_at') or f['time'])//86400000]+=f['pnl']/1_000_000
    if not daily:
        return {'status':'insufficient_resolved_data','unresolved':unresolved}
    days=list(daily.values());rng=random.Random(42)
    samples=sorted(statistics.mean(rng.choices(days,k=len(days))) for _ in range(iterations))
    return {'days':len(days),'net_pnl':sum(days),'mean_daily_pnl':statistics.mean(days),'one_sided_95pct_lower_mean_daily_pnl':samples[int(.05*iterations)],'unresolved':unresolved,'promotion':'NOT_AUTOMATIC: requires untouched holdout, cost stress, capacity and operational gates'}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('replay_result');args=p.parse_args()
    with open(args.replay_result,encoding='utf-8') as f:result=json.load(f)
    print(json.dumps(evaluate(result['fills']),indent=2))
