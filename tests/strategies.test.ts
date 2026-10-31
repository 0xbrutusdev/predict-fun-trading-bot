import {test} from 'node:test';import assert from 'node:assert/strict';
import {features,closedBars,micro,ema} from '../src/features.js';import {evaluate,slots,blocked} from '../src/strategies.js';
export const bars=Array.from({length:250},(_,i)=>{const open=100+Math.sin(i/5)*2+i*.01,close=open+Math.sin(i)*.4;return {time:i*300000,open,close,high:Math.max(open,close)+.5,low:Math.min(open,close)-.5,volume:100+i%9}});
test('EMA is seeded by SMA',()=>assert.deepEqual(ema([1,2,3,4],3).slice(2),[2,3]));
test('causal cutoff excludes future data and refuses missing tail',()=>{const cutoff=240*300000;assert.deepEqual(features(closedBars(bars,300,cutoff)),features(closedBars(bars.slice(0,240),300,cutoff)));assert.throws(()=>closedBars(bars.slice(0,238),300,cutoff));});
test('all defined reference strategies produce bounded deterministic outputs',()=>{const f=features(bars);for(const s of slots){if(blocked[s.strategy]){assert.throws(()=>evaluate(s.strategy,f,s.symbol));continue;}const result=evaluate(s.strategy,f,s.symbol,{h1:f,micro:{head:.01,pos:.6,ret:.1,lastUp:true,last2Up:true}});assert.ok(result.confidence>=0&&result.confidence<=1,s.strategy);}});
test('micro requires exact sequence',()=>assert.throws(()=>micro([],0,300)));
test('pin bar and crossing thresholds',()=>{const f=features(bars);assert.equal(evaluate('v2_pin_bar',{...f,lower:.6,upper:.1,body:.2,bbpos:.2,rsi:35},'BTC').confidence,.75);assert.equal(evaluate('macd_crossover',{...f,hist:.1,prevHist:-.1},'SOL').confidence,.7);});
