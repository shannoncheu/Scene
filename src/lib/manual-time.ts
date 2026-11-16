export function minuteIso(value:string){const date=new Date(value);if(!Number.isFinite(date.getTime()))throw new Error('INVALID_TIME');date.setUTCSeconds(0,0);return date.toISOString();}
export function localMinute(iso:string,timezone:string){
 const parts=new Intl.DateTimeFormat('en-GB',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(iso));
 const get=(key:string)=>parts.find(p=>p.type===key)!.value;
 return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}
export function watchedUtc(local:string,timezone:string,now=Date.now()){
 if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)||local.slice(0,4)<'1900')throw new Error('INVALID_TIME');
 const center=Date.parse(local+':00Z');if(!Number.isFinite(center)||new Date(center).toISOString().slice(0,16)!==local)throw new Error('INVALID_TIME');
 try{new Intl.DateTimeFormat('en',{timeZone:timezone}).format();}catch{throw new Error('INVALID_TIMEZONE');}
 const offsets=new Set<number>();
 for(const hours of [-36,-12,0,12,36]){const probe=center+hours*3600000;offsets.add(Date.parse(localMinute(new Date(probe).toISOString(),timezone)+':00Z')-probe);}
 const matches=[...offsets].map(offset=>center-offset).filter(value=>localMinute(new Date(value).toISOString(),timezone)===local);
 if(!matches.length)throw new Error('NONEXISTENT_LOCAL_TIME');
 if(matches.length!==1)throw new Error('AMBIGUOUS_LOCAL_TIME');
 if(matches[0]>now+60000)throw new Error('FUTURE_TIME');
 return new Date(matches[0]).toISOString();
}
