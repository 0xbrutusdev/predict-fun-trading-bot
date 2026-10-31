import {DatabaseSync} from 'node:sqlite';import {mkdirSync} from 'node:fs';import {dirname} from 'node:path';
export class Store{
 readonly db:DatabaseSync;
 constructor(path:string){if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});this.db=new DatabaseSync(path);this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS documents(kind TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(kind,id));
 CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,time INTEGER NOT NULL,type TEXT NOT NULL,json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS fills(id TEXT PRIMARY KEY,account TEXT NOT NULL,market TEXT NOT NULL,direction TEXT NOT NULL,quantity REAL NOT NULL,cost INTEGER NOT NULL,fee INTEGER NOT NULL,payout INTEGER,pnl INTEGER,time INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS fills_account ON fills(account,time);`);}
 get<T>(kind:string,id:string):T|undefined{const row=this.db.prepare('SELECT json FROM documents WHERE kind=? AND id=?').get(kind,id) as {json:string}|undefined;return row?JSON.parse(row.json):undefined;}
 put(kind:string,id:string,value:unknown){this.db.prepare('INSERT INTO documents VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET json=excluded.json').run(kind,id,JSON.stringify(value));}
 list<T>(kind:string):T[]{return (this.db.prepare('SELECT json FROM documents WHERE kind=? ORDER BY id').all(kind) as {json:string}[]).map(x=>JSON.parse(x.json));}
 event(type:string,data:unknown,time=Date.now()){this.db.prepare('INSERT INTO events(time,type,json) VALUES(?,?,?)').run(time,type,JSON.stringify(data));}
 transaction<T>(fn:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r}catch(e){this.db.exec('ROLLBACK');throw e}}
 close(){this.db.close()}
}
