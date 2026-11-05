import { Store } from "./store.js";
import { features, closedBars, micro } from "./features.js";
import { evaluate, slots, blocked } from "./strategies.js";
import {
  checkpoint,
  decide,
  paperFill,
  type Account,
  type Phase,
} from "./execution.js";
import {
  asksFor,
  type Market,
  type Book,
  type Candle,
  type Direction,
} from "./domain.js";
type Run = {
  phase: Phase;
  direction: Direction;
  members: string[];
  filled: number;
  attempt: number;
  decisionPrice?: number;
  nextAttempt?: number;
  target: number;
  configRevision?: number;
  strategyVersion?: string;
  executionPolicy?: string;
};
function phaseAt(duration: 300 | 900, elapsedMs: number): Phase {
  if (duration === 300)
    return elapsedMs <= 11000 ? "t1" : elapsedMs <= 218000 ? "late" : "done";
  return elapsedMs <= 95000
    ? "t1"
    : elapsedMs <= 140000
      ? "t2"
      : elapsedMs <= 230000
        ? "t3"
        : "done";
}
export class Engine {
  constructor(readonly store: Store) {}
  async step(now = Date.now()) {
    for (const a of (await this.store.list<Account>("account")).filter(
      (a) => a.enabled,
    ))
      for (const m of (await this.store.list<Market>("market")).filter(
        (m) => m.status === "OPEN" && m.start <= now && now < m.end,
      )) {
        const key = `${a.id}:${m.id}`;
        let run = await this.store.get<Run>("run", key);
        try {
          if (!run) {
            const conf = await this.store.get<{
              enabledSlots: string[];
              revision?: number;
            }>("config", a.id);
            const chosen = slots.filter(
              (s) =>
                s.symbol === m.symbol &&
                s.duration === m.duration &&
                (!conf || conf.enabledSlots.includes(s.id)) &&
                !blocked[s.strategy],
            );
            if (!chosen.length) continue;
            const all =
              (await this.store.get<Candle[]>(
                "candles",
                `${m.symbol}:${m.duration}`,
              )) || [];
            const f = features(closedBars(all, m.duration, m.start));
            const one =
              (await this.store.get<Candle[]>("candles", `${m.symbol}:60`)) ||
              [];
            const mic = micro(one, m.start - m.duration * 1000, m.duration);
            const h1 =
              (await this.store.get<Candle[]>("candles", `${m.symbol}:3600`)) ||
              [];
            const cutoff =
              Math.floor((m.start - m.duration * 1000) / 3600000) * 3600000;
            let h: ReturnType<typeof features> | undefined;
            try {
              h = features(closedBars(h1, 3600, cutoff));
            } catch {}
            const signals = [];
            for (const s of chosen) {
              try {
                const sig = evaluate(s.strategy, f, s.symbol, {
                  micro: mic,
                  h1: h,
                });
                if (sig.confidence >= s.threshold) signals.push(sig);
              } catch (e) {
                await this.store.event(
                  "signal.blocked",
                  {
                    accountId: a.id,
                    marketId: m.id,
                    strategy: s.strategy,
                    reason: String(e),
                  },
                  now,
                );
              }
            }
            await this.store.put("features", key, {
              time: now,
              marketId: m.id,
              accountId: a.id,
              features: f,
              signals,
            });
            if (
              !signals.length ||
              new Set(signals.map((s) => s.direction)).size > 1
            ) {
              await this.store.put("run", key, {
                phase: "done",
                reason: signals.length ? "direction_conflict" : "no_signal",
              });
              continue;
            }
            run = {
              phase: phaseAt(m.duration, now - m.start),
              direction: signals[0].direction,
              members: signals.map((s) => s.strategy).sort(),
              filled: 0,
              attempt: 0,
              target: a.fixedShares,
              configRevision: conf?.revision ?? 0,
              strategyVersion: "reference-ct4-v1",
              executionPolicy: "predict-paper-ct4-v2",
            };
            await this.store.put("run", key, run);
          }
          if (run.phase === "done") continue;
          run.filled = await this.store.sumFilledQuantity(
            a.id,
            m.id,
            run.direction,
          );
          if (run.filled >= run.target) {
            run.phase = "done";
            await this.store.put("run", key, run);
            continue;
          }
          const t = checkpoint(m.duration, run.phase),
            at = m.start + t * 1000;
          const history = (await this.store.get<Book[]>("books", m.id)) || [];
          if (now < at) continue;
          if (now > at + (m.duration === 300 ? 8000 : 20000)) {
            const expiredPhase = run.phase,
              future = phaseAt(m.duration, now - m.start);
            run.phase = future === expiredPhase ? "done" : future;
            await this.store.event(
              "checkpoint.skipped",
              {
                key,
                phase: expiredPhase,
                reason: "late",
                next: run.phase,
              },
              now,
            );
            await this.store.put("run", key, run);
            continue;
          }
          const book = history.filter((b) => b.receivedAt <= now).at(-1);
          if (!book) continue;
          if (run.nextAttempt && now < run.nextAttempt) continue;
          const samples = [at - 2000, at - 1000, at].map((time) => {
            const b = history
              .filter((x) => x.receivedAt <= time && x.updatedAt <= time)
              .at(-1);
            return b &&
              time - b.receivedAt <= 1000 &&
              time - b.updatedAt <= 1000
              ? asksFor(b, m, run!.direction)[0]?.[0]
              : undefined;
          });
          const decision = decide(
            m.duration,
            run.phase,
            samples.filter((x): x is number => x !== undefined),
            run.filled > 0,
          );
          if (decision.buy) {
            const current = asksFor(book, m, run.direction)[0]?.[0];
            if (current === undefined) continue;
            const anchor =
              run.decisionPrice ??
              [...(samples as number[])].sort((a, b) => a - b)[1];
            run.decisionPrice = anchor;
            const band =
              m.duration === 300
                ? [0.45, 0.9]
                : run.phase === "t1"
                  ? [0.6, 0.76]
                  : run.phase === "t2"
                    ? [0.72, 0.95]
                    : [0.82, 0.92];
            if (
              current <= anchor + 0.03 &&
              current >= band[0] &&
              current < band[1]
            ) {
              const limit = Math.min(
                0.95,
                Math.round((current + m.tick) / m.tick) * m.tick,
              );
              const result = await paperFill(
                this.store,
                a.id,
                m,
                book,
                run.direction,
                run.target,
                limit,
                `${key}:${run.phase}:${run.attempt}`,
                now,
              );
              run.filled += result.quantity;
              await this.store.event(
                "checkpoint.decision",
                { key, phase: run.phase, samples, limit, result },
                now,
              );
            }
            run.attempt++;
            if (run.filled < run.target && run.attempt < 4) {
              run.nextAttempt = now + 1000;
              await this.store.put("run", key, run);
              continue;
            }
          }
          run.phase = run.filled >= run.target ? "done" : decision.next;
          run.attempt = 0;
          delete run.nextAttempt;
          delete run.decisionPrice;
          await this.store.put("run", key, run);
        } catch (e) {
          const message = String(e);
          const previous = await this.store.get<{ reason: string }>(
            "lastError",
            key,
          );
          if (previous?.reason !== message) {
            await this.store.event(
              "engine.skip",
              { key, reason: message },
              now,
            );
            await this.store.put("lastError", key, {
              reason: message,
              time: now,
            });
          }
        }
      }
  }
}
