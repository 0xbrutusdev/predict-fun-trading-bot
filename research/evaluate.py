"""Dependency-free day-block bootstrap of exported fills; no alpha claims from synthetic data."""
import argparse, json, random, statistics
from collections import defaultdict

def evaluate(fills, iterations=10000):
    if not isinstance(iterations,int) or iterations < 100:
        raise ValueError('iterations must be at least 100')
    daily=defaultdict(float)
    unresolved=0
    for f in fills:
        if f.get('pnl') is None:
            unresolved+=1
            continue
        timestamp=f.get('settled_at')
        if timestamp is None:
            timestamp=f['time']
        daily[int(timestamp)//86400000]+=f['pnl']/1_000_000
    if not daily:
        return {'status':'insufficient_resolved_data','unresolved':unresolved}
    # Include zero-PnL days inside the observed settlement interval.
    days=[daily.get(day,0.0) for day in range(min(daily),max(daily)+1)]
    rng=random.Random(42)
    samples=sorted(statistics.mean(rng.choices(days,k=len(days))) for _ in range(iterations))
    return {'days':len(days),'net_pnl':sum(days),'mean_daily_pnl':statistics.mean(days),'one_sided_95pct_lower_mean_daily_pnl':samples[int(.05*iterations)],'unresolved':unresolved,'promotion':'NOT_AUTOMATIC: requires untouched holdout, cost stress, capacity and operational gates'}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('replay_result');args=p.parse_args()
    with open(args.replay_result,encoding='utf-8') as f:result=json.load(f)
    print(json.dumps(evaluate(result['fills']),indent=2))
