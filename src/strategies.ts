import type {Direction,Signal} from './domain.js';
import {clamp,type Features,type micro} from './features.js';
type Result=[Direction,number];const out=(up:boolean,c:number):Result=>[up?'up':'down',c];
type Context={micro?:ReturnType<typeof micro>;h1?:Features};
export const slots=[
 ['BTC',900,'regime_adaptive',.6],['BTC',900,'v14_signal_reclaim',.5],['DOGE',900,'v10_apex',.6],['DOGE',900,'v14_signal_reclaim',.5],['DOGE',900,'v9_consensus_gate',.45],['ETH',900,'v14_signal_reclaim',.5],['ETH',900,'v2_rsi_shift',.6],['ETH',900,'v8_anti_momentum_a',.55],['SOL',900,'macd_crossover',.6],['SOL',900,'v2_pin_bar',.6],['SOL',900,'v8_anti_momentum_a_m2',.55],['BTC',300,'v18_trend_pullback_5m',.548],['BTC',300,'v19_anchor_trend_counter_5m',.62],['BTC',300,'v5_vol_regime',.6],['ETH',300,'regime_adaptive',.6],['ETH',300,'v19_anchor_trend_5m',.62],['ETH',300,'v8_ultra_conf',.6],['SOL',300,'v2_pin_bar',.6],['SOL',300,'v3_precision',.6],['SOL',300,'v7_ultra_conf_a',.6]
].map(([symbol,duration,strategy,threshold],i)=>({id:String(i+1),symbol:String(symbol),duration:Number(duration),strategy:String(strategy),threshold:Number(threshold)}));
export const blocked:Record<string,string>={v9_consensus_gate:'DayEfficiencySoFar undefined in source',v19_anchor_trend_counter_5m:'CloseChg3Pct undefined in source',v19_anchor_trend_5m:'CloseChg3Pct undefined in source'};
function base(f:Features,kind:string):Result{
 if(kind==='am'){const z=Math.abs(f.ret)/f.ap;if(z<.3)return out(f.c>f.o,.05);const u=f.ret<0;let c=Math.min(z/2,1);if(u?f.rsi<25:f.rsi>65)c=Math.min(c*1.2,.99);if(u?f.rsi>65:f.rsi<25)c*=.5;return out(u,c);}
 if(kind==='bb'){const pos=f.bbpos;if(pos>=.15&&pos<=.85)return out(f.c<f.bbmid,.05);const u=pos<.15;let c=Math.min(u?(.15-pos)/.15:(pos-.85)/.15,1);if(f.adx>35)c*=.85;if(u?f.rsi<30:f.rsi>70)c=Math.min(c*1.2,.99);if(u?f.rsi>70:f.rsi<30)c*=.5;return out(u,c);}
 const a=Math.abs(f.consec),u=f.consec<0;let c=.01;if(a>=4){c=Math.min((a-3)*.2+.6,.95);if(u?f.rsi<35:f.rsi>65)c=Math.min(c+.1,.95);if(u?f.bbpos<.2:f.bbpos>.8)c=Math.min(c+.1,.95);}else if(a===3)c=(u?f.rsi<40:f.rsi>60)?.6:.45;else return out(f.c>=f.o,c);if(u?f.rsi<35:f.rsi>58)c=Math.min(c*1.2,.99);if(u?f.rsi>58:f.rsi<35)c*=.5;return out(u,c);
}
function legacy(f:Features,kind:string):Result{
 let[d,c]=base(f,kind);if(c<=.05)return[d,c];const u=d==='up',am=kind==='am',bb=kind==='bb';
 if(!am&&f.adx>(bb?43:35))c*=bb?.95:.9;
 const n=[u?f.stoch>(am?70:75):f.stoch<(am?30:25),u?f.wr>(am?-10:-15):f.wr<(am?-90:-85),u?f.ob>(am?.2:.25):f.ob<-(am?.2:.25)].filter(Boolean).length;
 if(n>=2)c*=am?.3:bb?.25:.15;else if(n)c*=am?.7:bb?.75:.65;
 if(f.wr>-60&&f.wr<-40)c*=am?.75:bb?.8:.7;if(Math.abs(f.ob)<.1)c*=kind==='cr'?.85:.92;
 if(bb&&c>.1&&(u?f.kcpos<.1:f.kcpos>.9))c=Math.min(c*1.12,.95);
 const supports=[u?f.stoch<(kind==='cr'?40:30):f.stoch>(kind==='cr'?60:70),u?f.ob<-.15:f.ob>.15,...(kind==='cr'?[]:[u?f.cmf<-.03:f.cmf>.03]),...(am?[u?f.wr<-70:f.wr>-30]:[])].filter(Boolean).length;
 if(am&&supports>=3)c=Math.min(c*1.2,.95);else if(supports>=2)c=Math.min(c*(am?1.1:1.12),.95);
 if(f.vol>(am?1.5:1.8))c=Math.min(c*1.08,.95);else if(f.vol<(am?.7:.6))c*=am?.92:.88;return[d,c];
}
function tunedAM(f:Features,symbol:string):Result{
 let[d,c]=base(f,'am');if(c<=.05)return[d,c];const u=d==='up',sol=symbol==='SOL';const lo=sol?20:30,hi=sol?70:70;
 const n=[u?f.stoch>hi:f.stoch<lo,u?f.wr>-10:f.wr<-90,u?f.ob>.2:f.ob<-.2].filter(Boolean).length;c*=n>=2?.3:n===1?.7:1;
 if(f.wr>(sol?-60:-45)&&f.wr<(sol?-25:-30))c*=sol?.7:.75;if(Math.abs(f.ob)<.1)c*=sol?.92:.88;
 const support=[u?f.stoch<lo:f.stoch>hi,u?f.wr<-70:f.wr>-30,u?f.ob<-.15:f.ob>.15,u?f.cmf<-.03:f.cmf>.03].filter(Boolean).length;
 if(support>=2)c=Math.min(c*(support>=3?1.2:1.1),.95);
 const confirms=[u?f.stoch<30:f.stoch>70,u?f.wr<-70:f.wr>-30,u?f.cmf<-.03:f.cmf>.03,u?f.vwapdev<-.04:f.vwapdev>.04,u?f.ob<-.15:f.ob>.15].filter(Boolean).length;
 if(confirms<=1)c*=.5;else if(confirms>=3)c=Math.min(c*(confirms>=4?1.18:1.1),.95);
 if(f.vol>(sol?2.5:1.3))c=Math.min(c*1.08,.95);else if(f.vol<.7)c*=.92;return[d,c];
}
function full(f:Features,sol:boolean):Result{
 let up=0,down=0;const add=(u:boolean,v:number)=>{if(u)up+=v;else down+=v};const trend=(f.ema5-f.ema20)/f.atr;
 if(Math.abs(trend)>(sol?.3:.2))add(trend>0,1);
 if(f.rsi>(sol?75:65))down+=(f.rsi-50)/30;else if(f.rsi<35)up+=(50-f.rsi)/30;
 for(const [x,hi,lo,w] of [[f.bbpos,sol?.92:.82,sol?.1:.18,.7],[f.kcpos,sol?.92:.85,sol?.08:.15,.6],[f.hlpos,sol?.92:.85,sol?.2:.15,.5]]){if(x>hi)down+=w;else if(x<lo)up+=w;}
 if(Math.abs(f.consec)>=3)add(f.consec<0,.5);if(f.buy5>.65)down+=.4;else if(f.buy5<.35)up+=.4;
 if(Math.abs(f.dev/f.ap)>(sol?1:.8))add(f.dev<0,.6);if(Math.abs(f.ret/f.ap)>(sol?1.2:.8))add(f.ret<0,.5);
 if(f.squeeze>0&&f.squeeze>f.prevSqueeze)up+=.4;else if(f.squeeze<0&&f.squeeze<f.prevSqueeze)down+=.4;
 return up+down<4?out(f.c>=f.o,.01):out(up>down,Math.min(Math.max(up,down)/4,.9));
}
export function evaluate(name:string,f:Features,symbol:string,ctx:Context={}):Signal{
 if(blocked[name])throw Error(blocked[name]);let r:Result;
 switch(name){
 case 'regime_adaptive':r=f.adx>25?(f.bbwidth>3?out(f.ema20>f.ema50,Math.min(f.adx/50,1)):out(f.ema20>f.ema50,.3)):(f.bbwidth<=3?out(f.rsi<50,Math.min(Math.abs(f.rsi-50)/25,1)):out(f.c<f.bbmid,Math.min(2*Math.abs(f.c-f.bbmid)/(f.bbhi-f.bblo),1)));break;
 case 'macd_crossover':r=out(f.hist>0,f.prevHist!==0&&f.hist*f.prevHist<0?.7:.1);break;
 case 'v2_pin_bar':r=f.lower>.55&&f.body<.3&&f.upper<.15?out(true,.5+(f.bbpos<.3?.15:0)+(f.rsi<40?.1:0)):f.upper>.55&&f.body<.3&&f.lower<.15?out(false,.5+(f.bbpos>.7?.15:0)+(f.rsi>60?.1:0)):out(f.c>=f.o,.02);break;
 case 'v2_rsi_shift':{const delta=f.rsi-f.prevRsi;r=Math.abs(delta)<5?out(f.rsi>50,.02):delta>0&&f.prevRsi<40?out(true,Math.min(delta/15+.3,.9)):delta<0&&f.prevRsi>60?out(false,Math.min(-delta/15+.3,.9)):out(delta>0,Math.min(Math.abs(delta)/20+.15,.7));break;}
 case 'v5_vol_regime':{let u=0,d=0;if(f.up50>.56)d+=(f.up50-.5)*4;else if(f.up50<.44)u+=(.5-f.up50)*4;if(f.rsi>65)d+=(f.rsi-50)/30;else if(f.rsi<35)u+=(50-f.rsi)/30;if(f.bbpos>.82)d+=.6;else if(f.bbpos<.18)u+=.6;if(f.buy5>.65)d+=.4;else if(f.buy5<.35)u+=.4;let c=Math.min(Math.max(u,d)/3,.9);if(f.regime>1.15)c=Math.min(c*1.2,.9);else if(f.regime<.85)c*=.7;r=u+d<.8?out(f.c>=f.o,.01):out(u>d,c);break;}
 case 'v3_precision':{const votes:[boolean,number][]=[];if(Math.abs(f.consec)>=3)votes.push([f.consec<0,3]);if(Math.abs(f.ret)/f.ap>1.3)votes.push([f.ret<0,2.5]);if(f.bbpos<.12||f.bbpos>.88)votes.push([f.bbpos<.12,2]);if(f.rsi>72||f.rsi<28)votes.push([f.rsi<28,1.8]);if(f.body<.3&&(f.upper>.5||f.lower>.5))votes.push([f.lower>.5,1.5]);if(f.body>.55&&f.vol<f.prevVol*.6&&f.vol<.7)votes.push([f.c<f.o,1.2]);const u=votes.filter(x=>x[0]).reduce((s,x)=>s+x[1],0),d=votes.filter(x=>!x[0]).reduce((s,x)=>s+x[1],0),dom=Math.max(u,d);r=votes.length<2?out(f.c>=f.o,.01):Math.min(u,d)>dom*.4?out(u>d,.05):out(u>d,Math.min(dom/(u+d)*Math.min(dom/4,1),.95));break;}
 case 'v8_anti_momentum_a':case 'v8_anti_momentum_a_m2':{r=tunedAM(f,symbol);if(!ctx.micro)throw Error('micro_required');if((name.endsWith('_m2')?ctx.micro.last2Up:ctx.micro.lastUp)!==(r[0]==='up'))r[1]=.02;break;}
 case 'v7_ultra_conf_a':{r=full(f,true);if(!ctx.micro)throw Error('micro_required');if((ctx.micro.ret>=0)!==(r[0]==='up'))r[1]=.02;break;}
 case 'v8_ultra_conf':{r=full(f,false);if(r[1]<=.05)break;const u=r[0]==='up';const n=[u?f.stoch>75:f.stoch<25,u?f.wr>-15:f.wr<-85,u?f.ob>.25:f.ob<-.25].filter(Boolean).length;r[1]*=n>=2?.2:n===1?.75:1;const s=[u?f.stoch<30:f.stoch>70,u?f.ob<-.15:f.ob>.15,u?f.cmf<-.03:f.cmf>.03].filter(Boolean).length;if(s>=2)r[1]=Math.min(r[1]*1.12,.95);if(f.vol>1.5)r[1]=Math.min(r[1]*1.08,.95);else if(f.vol<.3)r[1]*=.7;break;}
 case 'v14_signal_reclaim':{const sub=['am','bb','cr'].map(x=>legacy(f,x));const kept=sub.filter(x=>x[1]>.15);let con:Result=out(f.c>f.o,.03);if(kept.length>=2){const up=kept.filter(x=>x[0]==='up').length,agree=Math.max(up,kept.length-up);con=out(up>kept.length-up,agree<2?.05:Math.min(kept.reduce((s,x)=>s+x[1],0)/kept.length*(.7+.15*agree),.95));}const ranges=[[.3,.65],[.3,.7],[.5,.7],[.4,.55]];const votes=[...sub,con].filter((x,i)=>x[1]>=ranges[i][0]&&x[1]<ranges[i][1]);if(!votes.length){r=out(f.c>=f.o,.01);break;}const up=votes.filter(x=>x[0]==='up').length,agree=Math.max(up,votes.length-up),u=up>votes.length-up;if(votes.length>1&&agree<=Math.floor(votes.length/2)){r=out(u,.03);break;}let c=votes.reduce((s,x)=>s+x[1],0)/votes.length;if(agree>=2)c=Math.min(c*(agree>=3?1.25:1.15),agree>=3?.9:.85);const n=[u?f.stoch>80:f.stoch<20,u?f.wr>-5:f.wr<-95].filter(Boolean).length;c*=n>=2?.3:n===1?.7:1;if([u?f.cmf>.03:f.cmf<-.03,u?f.buy>.55:f.buy<.45,f.vol>1.2].filter(Boolean).length>=2)c=Math.min(c*1.12,.9);r=out(u,c);break;}
 case 'v18_trend_pullback_5m':{if(!ctx.h1||!ctx.micro)throw Error('h1_and_micro_required');const h=ctx.h1,t=Math.sign(h.ema20-h.ema50);if(!t||f.ret*t>=0){r=out(t>0,.02);break;}const score=-.03-.07*clamp(f.dev/f.ap*t,-3,3)-.04*clamp(f.consec/5*t,-3,3)-.28*clamp(ctx.micro.head/f.ap*t,-2,2)+.04*(2*ctx.micro.pos-1)*t+.03*f.adx/50+.03*clamp(Math.abs(100*(h.ema20-h.ema50)/h.ema50)/2,0,2);const p=1/(1+Math.exp(-score));r=out(t>0,p<.5?.02:p);break;}
 case 'v10_apex':{let o=0,s=0;if(f.rsi>65)o+=Math.min((f.rsi-60)/25,1)*1.5;else if(f.rsi<35)s+=Math.min((35-f.rsi)/25,1)*1.5;for(const [x,w] of [[f.bbpos,2],[f.kcpos,1.2]]){if(x>.78)o+=(x-.5)*w;else if(x<.22)s+=(.5-x)*w;}if(f.consec>=3)o+=Math.min((f.consec-2)*.3,.9);else if(f.consec<=-3)s+=Math.min((-f.consec-2)*.3,.9);const z=f.ret/f.ap;if(z>.9)o+=Math.min((z-.5)*.5,.8);else if(z<-.9)s+=Math.min((-z-.5)*.5,.8);if(f.buy5>.65)o+=(f.buy5-.5)*1.5;else if(f.buy5<.35)s+=(.5-f.buy5)*1.5;if(f.dev/f.ap>.5)o+=Math.min(f.dev/f.ap*.5,.8);else if(f.dev/f.ap<-.5)s+=Math.min(-f.dev/f.ap*.5,.8);const dom=Math.max(o,s),u=s>o;if(dom<2||Math.min(o,s)>dom*.3||f.adx>33||(u?f.rsi>62||f.bbpos>.72:f.rsi<38||f.bbpos<.28)){r=out(f.c>=f.o,.01);break;}let c=Math.min(dom/5+.2,.95);if([u?f.stoch<28:f.stoch>72,u?f.wr<-72:f.wr>-28,u?f.cmf<-.03:f.cmf>.03,u?f.ob<-.18:f.ob>.18].filter(Boolean).length>=2)c=Math.min(c+.08,.95);if(f.vol>1.3)c=Math.min(c*1.06,.95);else if(f.vol<.35)c*=.7;r=out(u,c);break;}
 default:throw Error('unknown_strategy');
 }if(!Number.isFinite(r[1]))throw Error('invalid_signal');return {strategy:name,direction:r[0],confidence:r[1]};
}
