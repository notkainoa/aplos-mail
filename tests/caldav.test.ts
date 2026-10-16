import test from 'node:test';
import assert from 'node:assert/strict';
import { CalDavError, createCalDav } from '../src/main/caldav';
import { parseComponents, parseTime, readEvents, unfold } from '../src/main/ical';
import type { Account, CalendarEvent } from '../src/shared/types';

interface Req { url:string; method:string; headers:Record<string,string>; body?:string }
type Handler=(req:Req)=>Response|Promise<Response>;

const account={id:'acct',name:'Kim',email:'kim@example.test',color:'#000',provider:'imap',connected:true} as Account;
const creds={url:'https://caldav.example.test/.well-known/caldav',username:'kim@example.test',password:'app-pass'};
const now=()=>new Date('2026-10-01T12:00:00Z');
const part='https://p07-caldav.example.test/1234/calendars/';
const home=`${part}home/`,work=`${part}work/`;

function server(routes:Record<string,Handler>) {
  const calls:Req[]=[];
  const fake=(async(input:unknown,init:RequestInit={})=>{
    const req:Req={url:String(input),method:init.method??'GET',headers:Object.fromEntries(Object.entries((init.headers??{}) as Record<string,string>).map(([k,v])=>[k.toLowerCase(),v])),body:init.body as string|undefined};
    calls.push(req);
    const handler=routes[`${req.method} ${req.url}`];
    return handler?handler(req):new Response('not here',{status:404});
  }) as typeof fetch;
  return {fetch:fake,calls,routes};
}
const multi=(...responses:string[])=>new Response(`<?xml version="1.0" encoding="UTF-8"?><d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">${responses.join('')}</d:multistatus>`,{status:207,headers:{'content-type':'text/xml'}});
const ok=(href:string,props:string)=>`<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
const cal=(...lines:string[])=>['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Fixture Co//Test Server//EN',...lines,'END:VCALENDAR'].join('\r\n')+'\r\n';
const xmlText=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;');
const resource=(href:string,etag:string,data:string)=>ok(href,`<d:getetag>"${etag}"</d:getetag><cal:calendar-data>${xmlText(data)}</cal:calendar-data>`);

const standup=cal('BEGIN:VEVENT','UID:standup-1','DTSTAMP:20260901T000000Z','DTSTART:20261016T140000Z','DTEND:20261016T143000Z',
  'SUMMARY:Planning\\, budget\\; and review','DESCRIPTION:Line one\\nLine two with a backslash \\\\ and a long sentence that',
  '  continues on a folded line','LOCATION:Room 4','ORGANIZER;CN=Kim:mailto:kim@example.test',
  'ATTENDEE;CN=Ana;PARTSTAT=ACCEPTED:mailto:ana@example.test','ATTENDEE;CN="Ben, B.":mailto:ben@example.test',
  'X-FIXTURE-COLOR:teal','BEGIN:VALARM','ACTION:DISPLAY','TRIGGER:-PT10M','DESCRIPTION:Reminder','END:VALARM','END:VEVENT');
const nyTz=['BEGIN:VTIMEZONE','TZID:America/New_York','BEGIN:STANDARD','DTSTART:19701101T020000','TZOFFSETFROM:-0400','TZOFFSETTO:-0500','END:STANDARD','END:VTIMEZONE'];
const exchangeTz=['BEGIN:VTIMEZONE','TZID:W. Europe Standard Time',
  'BEGIN:STANDARD','DTSTART:16010101T030000','TZOFFSETFROM:+0200','TZOFFSETTO:+0100','RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10','END:STANDARD',
  'BEGIN:DAYLIGHT','DTSTART:16010101T020000','TZOFFSETFROM:+0100','TZOFFSETTO:+0200','RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3','END:DAYLIGHT','END:VTIMEZONE'];
const weekly=cal('BEGIN:VEVENT','UID:weekly-1','RECURRENCE-ID:20261005T150000Z','DTSTART:20261005T150000Z','DTEND:20261005T160000Z','SUMMARY:Weekly sync','END:VEVENT',
  'BEGIN:VEVENT','UID:weekly-1','RECURRENCE-ID:20261012T150000Z','DTSTART:20261012T153000Z','DTEND:20261012T163000Z','SUMMARY:Weekly sync (moved)','END:VEVENT');
const weeklyMaster=cal('BEGIN:VEVENT','UID:weekly-1','DTSTAMP:20260901T000000Z','DTSTART;TZID=America/New_York:20261005T110000','DTEND;TZID=America/New_York:20261005T120000','RRULE:FREQ=WEEKLY;BYDAY=MO','SUMMARY:Weekly sync','SEQUENCE:2','END:VEVENT');

function caldavServer() {
  const s=server({
    // iCloud-style: the well-known address redirects, the principal lives on the main host and the home on a partition host.
    'PROPFIND https://caldav.example.test/.well-known/caldav':()=>new Response(null,{status:301,headers:{location:'/'}}),
    'PROPFIND https://caldav.example.test/':()=>multi(ok('/','<d:current-user-principal><d:href>/1234/principal/</d:href></d:current-user-principal>')),
    'PROPFIND https://caldav.example.test/1234/principal/':()=>multi(ok('/1234/principal/','<cal:calendar-home-set><d:href xmlns:d="DAV:">https://p07-caldav.example.test:443/1234/calendars/</d:href></cal:calendar-home-set>')),
    [`PROPFIND ${part}`]:()=>multi(
      ok('/1234/calendars/','<d:resourcetype><d:collection/></d:resourcetype>'),
      ok('/1234/calendars/work/','<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><d:displayname>Work</d:displayname><cal:supported-calendar-component-set><cal:comp name="VEVENT"/></cal:supported-calendar-component-set><d:current-user-privilege-set><d:privilege><d:read/></d:privilege></d:current-user-privilege-set>'),
      `<d:response><d:href>/1234/calendars/home/</d:href><d:propstat><d:prop><resourcetype xmlns="DAV:"><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype><d:displayname>Home &amp; Family</d:displayname><cal:supported-calendar-component-set><cal:comp name="VEVENT"/><cal:comp name="VTODO"/></cal:supported-calendar-component-set><d:current-user-privilege-set><d:privilege><d:read/></d:privilege><d:privilege><d:write/></d:privilege></d:current-user-privilege-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
      ok('/1234/calendars/tasks/','<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><d:displayname>Tasks</d:displayname><cal:supported-calendar-component-set><cal:comp name="VTODO"/></cal:supported-calendar-component-set>'),
      ok('/1234/calendars/inbox/','<d:resourcetype><d:collection/><cal:schedule-inbox/></d:resourcetype>')),
    [`REPORT ${home}`]:()=>multi(
      resource('/1234/calendars/home/standup.ics','e1',standup),
      resource('/1234/calendars/home/ny.ics','e2',cal(...nyTz,'BEGIN:VEVENT','UID:ny-1','DTSTART;TZID=America/New_York:20261016T090000','DTEND;TZID=America/New_York:20261016T100000','SUMMARY:Summer call','END:VEVENT')),
      resource('/1234/calendars/home/ny2.ics','e3',cal('BEGIN:VEVENT','UID:ny-2','DTSTART;TZID="/example.org/2026a/America/New_York":20261210T090000','DURATION:PT45M','SUMMARY:Winter call','END:VEVENT')),
      resource('/1234/calendars/home/trip.ics','e4',cal('BEGIN:VEVENT','UID:trip-1','DTSTART;VALUE=DATE:20261020','DTEND;VALUE=DATE:20261022','SUMMARY:Trip','END:VEVENT')),
      resource('/1234/calendars/home/gone.ics','e5',cal('BEGIN:VEVENT','UID:gone-1','DTSTART:20261018T100000Z','DTEND:20261018T110000Z','STATUS:CANCELLED','SUMMARY:Cancelled','END:VEVENT')),
      resource('/1234/calendars/home/weekly.ics','e6',weekly),
      // Entity-encoded carriage returns, as some servers send them.
      ok('/1234/calendars/home/berlin.ics',`<d:getetag>"e7"</d:getetag><cal:calendar-data>${cal(...exchangeTz,'BEGIN:VEVENT','UID:berlin-1','DTSTART;TZID=W. Europe Standard Time:20261016T100000','DTEND;TZID=W. Europe Standard Time:20261016T110000','SUMMARY:Berlin review','END:VEVENT').replace(/\r\n/g,'&#13;\n')}</cal:calendar-data>`)),
    [`REPORT ${work}`]:()=>multi(`<d:response><d:href>/1234/calendars/work/floating.ics</d:href><d:propstat><d:prop><d:getetag>"w1"</d:getetag><cal:calendar-data><![CDATA[${cal('BEGIN:VEVENT','UID:float-1','DTSTART:20261017T080000','DTEND:20261017T083000','SUMMARY:Floating breakfast','END:VEVENT')}]]></cal:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`),
  });
  return s;
}

test('discovery follows the redirect to the partition host and lists only event calendars', async () => {
  const s=caldavServer(),dav=createCalDav({fetch:s.fetch,now});
  await dav.verify(creds);
  const calendars=await dav.listCalendars(creds,account);
  assert.deepEqual(calendars,[{id:work,name:'Work',accountId:'acct'},{id:home,name:'Home & Family',accountId:'acct',primary:true}],'the first writable calendar is the default');
  assert.equal(s.calls.filter(c=>c.url.endsWith('/principal/')).length,1,'discovery is cached after verify');
  const first=s.calls[0];
  assert.equal(first.headers.authorization,`Basic ${Buffer.from('kim@example.test:app-pass').toString('base64')}`);
  assert.equal(first.headers.depth,'0');
  assert.equal(s.calls.find(c=>c.url===part)?.headers.depth,'1');
  assert.equal(s.calls[1].url,'https://caldav.example.test/');
  assert.match(String(s.calls[1].body),/current-user-principal/);
});

test('events are parsed across time zones, all-day spans, attendees, escapes and expanded recurrences', async () => {
  const s=caldavServer(),dav=createCalDav({fetch:s.fetch,now});
  const events=await dav.listEvents(creds,account);
  const report=s.calls.find(c=>c.method==='REPORT'&&c.url===home)!;
  assert.equal(report.headers.depth,'1');
  assert.match(String(report.body),/<C:expand start="20260901T120000Z" end="20271001T120000Z"\/>/);
  assert.match(String(report.body),/<C:time-range start="20260901T120000Z" end="20271001T120000Z"\/>/);
  const by=(title:string)=>events.find(e=>e.title===title)!;
  assert.deepEqual(by('Planning, budget; and review'),{id:`acct:${home}:standup-1`,accountId:'acct',calendarId:home,title:'Planning, budget; and review',start:'2026-10-16T14:00:00.000Z',end:'2026-10-16T14:30:00.000Z',allDay:false,location:'Room 4',description:'Line one\nLine two with a backslash \\ and a long sentence that continues on a folded line',guests:['ana@example.test','ben@example.test'],remoteId:`${home}standup.ics`});
  assert.deepEqual([by('Summer call').start,by('Summer call').end],['2026-10-16T13:00:00.000Z','2026-10-16T14:00:00.000Z']);
  assert.deepEqual([by('Winter call').start,by('Winter call').end],['2026-12-10T14:00:00.000Z','2026-12-10T14:45:00.000Z']);
  assert.deepEqual([by('Trip').start,by('Trip').end,by('Trip').allDay],['2026-10-20','2026-10-22',true]);
  assert.deepEqual([by('Berlin review').start,by('Berlin review').end],['2026-10-16T08:00:00.000Z','2026-10-16T09:00:00.000Z']);
  assert.equal(by('Floating breakfast').start,new Date(2026,9,17,8).toISOString());
  assert.equal(by('Floating breakfast').calendarId,work);
  assert.equal(events.some(e=>e.title==='Cancelled'),false);
  const weeklies=events.filter(e=>e.title.startsWith('Weekly sync'));
  assert.deepEqual(weeklies.map(e=>[e.id,e.start]),[[`acct:${home}:weekly-1:2026-10-05T15:00:00.000Z`,'2026-10-05T15:00:00.000Z'],[`acct:${home}:weekly-1:2026-10-12T15:00:00.000Z`,'2026-10-12T15:30:00.000Z']]);
  assert.equal(events.length,8);
});

test('iCalendar times handle DST gaps, repeated hours and Exchange-style zones', () => {
  const zones=new Map();
  const at=(line:string)=>parseTime(parseComponents(`BEGIN:X\r\n${line}\r\nEND:X`)[0].props[0],zones)?.iso;
  assert.equal(at('DTSTART;TZID=America/New_York:20261101T013000'),'2026-11-01T05:30:00.000Z','a repeated hour takes the first occurrence');
  assert.equal(at('DTSTART;TZID=America/New_York:20260308T023000'),'2026-03-08T07:30:00.000Z','a skipped hour uses the offset before the gap');
  assert.equal(at('DTSTART;TZID=Europe/Berlin:20260115T090000'),'2026-01-15T08:00:00.000Z');
  const winter=readEvents(cal(...exchangeTz,'BEGIN:VEVENT','UID:x','DTSTART;TZID=W. Europe Standard Time:20261210T100000','DTEND;TZID=W. Europe Standard Time:20261210T110000','END:VEVENT'));
  assert.equal(winter[0].start.iso,'2026-12-10T09:00:00.000Z');
  assert.deepEqual(unfold('A:one\r\n two\r\n\tthree\r\nB:x'),['A:onetwothree','B:x']);
});

const draft=(patch:Partial<CalendarEvent>={}):CalendarEvent=>({id:'local-1',accountId:'acct',calendarId:'primary',title:'Lunch, then; notes',start:'2026-10-16T12:00:00.000Z',end:'2026-10-16T13:00:00.000Z',allDay:false,location:'Café Ørsted',description:'Bring the plan\\draft.\nSecond line: '+'naïve café ☕ '.repeat(12),guests:['ana@example.test',' not an email '],...patch});

test('creating an event PUTs a folded, escaped iCalendar object into the first writable calendar', async () => {
  const s=caldavServer();
  let put:Req|undefined;
  // New resources get a random name, so PUTs are captured before exact-URL routing.
  const fetch=(async(input:unknown,init:RequestInit={})=>{
    if(init.method==='PUT'){put={url:String(input),method:'PUT',headers:init.headers as Record<string,string>,body:String(init.body)};return new Response(null,{status:201,headers:{etag:'"n1"'}});}
    return s.fetch(input as string,init);
  }) as typeof globalThis.fetch;
  const saved=await createCalDav({fetch,now}).saveEvent(creds,account,draft());
  assert.ok(put);
  assert.match(put.url,new RegExp(`^${home.replace(/[.]/g,'\\.')}[0-9a-f-]{36}\\.ics$`));
  assert.equal(put.headers['if-none-match'],'*');
  assert.equal(put.headers['content-type'],'text/calendar; charset=utf-8');
  assert.deepEqual({...saved,remoteId:undefined},{...draft(),calendarId:home,guests:['ana@example.test'],remoteId:undefined,url:undefined});
  assert.equal(saved.remoteId,put.url);
  const body=put.body!;
  for(const line of body.split('\r\n'))assert.ok(Buffer.byteLength(line)<=75,`line too long: ${line}`);
  assert.ok(body.split('\r\n').some(line=>line.startsWith(' ')),'long description is folded');
  assert.ok(!body.includes('\uFFFD'));
  for(const line of ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Aplos Mail//EN','CALSCALE:GREGORIAN','DTSTAMP:20261001T120000Z','DTSTART:20261016T120000Z','DTEND:20261016T130000Z','SUMMARY:Lunch\\, then\\; notes','ATTENDEE:mailto:ana@example.test','END:VCALENDAR'])assert.ok(unfold(body).includes(line),line);
  assert.ok(body.endsWith('END:VCALENDAR\r\n'));
  const [parsed]=readEvents(body);
  assert.equal(parsed.uid,put.url.split('/').pop()!.replace('.ics',''));
  assert.equal(parsed.description,draft().description);
  assert.equal(parsed.location,'Café Ørsted');

  const allDay=await createCalDav({fetch,now}).saveEvent(creds,account,draft({allDay:true,start:'2026-10-20',end:'2026-10-21'}));
  assert.ok(unfold(put.body!).includes('DTSTART;VALUE=DATE:20261020')&&unfold(put.body!).includes('DTEND;VALUE=DATE:20261021'));
  assert.deepEqual([allDay.start,allDay.end],['2026-10-20','2026-10-21']);

  await assert.rejects(createCalDav({fetch,now}).saveEvent(creds,account,draft({end:'2026-10-16T11:00:00.000Z'})),/valid start and end/);
  await assert.rejects(createCalDav({fetch,now}).saveEvent(creds,account,draft({calendarId:work})),(e:CalDavError)=>e.status===403);
});

test('updating keeps unknown properties, uses If-Match and reports conflicts', async () => {
  const s=caldavServer(),dav=createCalDav({fetch:s.fetch,now});
  const listed=(await dav.listEvents(creds,account)).find(e=>e.id.endsWith(':standup-1'))!;
  s.routes[`GET ${home}standup.ics`]=()=>new Response(standup,{headers:{etag:'"e1"'}});
  let put:Req|undefined;
  s.routes[`PUT ${home}standup.ics`]=req=>{put=req;return new Response(null,{status:204,headers:{etag:'"e1b"'}});};
  const saved=await dav.saveEvent(creds,account,{...listed,title:'Planning only',guests:['ana@example.test','cy@example.test']});
  assert.equal(saved.id,listed.id);
  assert.equal(saved.remoteId,`${home}standup.ics`);
  assert.equal(put!.headers['if-match'],'"e1"');
  const lines=unfold(put!.body!);
  for(const kept of ['UID:standup-1','DTSTART:20261016T140000Z','DTEND:20261016T143000Z','LOCATION:Room 4','ORGANIZER;CN=Kim:mailto:kim@example.test','ATTENDEE;CN=Ana;PARTSTAT=ACCEPTED:mailto:ana@example.test','X-FIXTURE-COLOR:teal','BEGIN:VALARM','TRIGGER:-PT10M','DESCRIPTION:Line one\\nLine two with a backslash \\\\ and a long sentence that continues on a folded line'])assert.ok(lines.includes(kept),kept);
  assert.ok(lines.includes('SUMMARY:Planning only'));
  assert.ok(lines.includes('ATTENDEE:mailto:cy@example.test'));
  assert.ok(!lines.some(l=>l.includes('ben@example.test')));
  assert.ok(lines.includes('DTSTAMP:20261001T120000Z'));

  // Changed on the server since it was listed: the stored ETag no longer matches, so nothing is written.
  s.routes[`GET ${home}standup.ics`]=()=>new Response(standup,{headers:{etag:'"e9"'}});
  put=undefined;
  await assert.rejects(dav.saveEvent(creds,account,{...listed,title:'Again'}),(e:CalDavError)=>e.status===412&&e.message==='This event changed on the server. Refresh the calendar and try again.'&&!e.uncertain);
  assert.equal(put,undefined);

  // The server itself refuses the precondition.
  const fresh=createCalDav({fetch:s.fetch,now});
  s.routes[`PUT ${home}standup.ics`]=()=>new Response(null,{status:412});
  await assert.rejects(fresh.saveEvent(creds,account,{...listed,title:'Again'}),(e:CalDavError)=>e instanceof CalDavError&&e.status===412);
});

test('repeating events: series edits keep RRULE, single occurrences are refused', async () => {
  const s=caldavServer(),dav=createCalDav({fetch:s.fetch,now});
  s.routes[`GET ${home}weekly.ics`]=()=>new Response(weeklyMaster,{headers:{etag:'"r1"'}});
  let put:Req|undefined;
  s.routes[`PUT ${home}weekly.ics`]=req=>{put=req;return new Response(null,{status:204});};
  const series:CalendarEvent={id:`acct:${home}:weekly-1`,accountId:'acct',calendarId:home,title:'Weekly sync',start:'2026-10-05T15:00:00.000Z',end:'2026-10-05T16:00:00.000Z',allDay:false,location:'',description:'',guests:[],remoteId:`${home}weekly.ics`};
  await dav.saveEvent(creds,account,{...series,title:'Weekly planning'});
  const lines=unfold(put!.body!);
  for(const kept of ['RRULE:FREQ=WEEKLY;BYDAY=MO','DTSTART;TZID=America/New_York:20261005T110000','SUMMARY:Weekly planning','SEQUENCE:3'])assert.ok(lines.includes(kept),kept);
  await dav.saveEvent(creds,account,{...series,start:'2026-10-05T16:00:00.000Z',end:'2026-10-05T17:00:00.000Z'});
  assert.ok(unfold(put!.body!).includes('DTSTART;TZID=America/New_York:20261005T120000'),'moving the series keeps its zone');

  put=undefined;
  const instance={...series,id:`acct:${home}:weekly-1:2026-10-12T15:00:00.000Z`};
  await assert.rejects(dav.saveEvent(creds,account,{...instance,title:'Just this one'}),/one occurrence of a repeating event/);
  await assert.rejects(dav.deleteEvent(creds,account,instance),/one occurrence of a repeating event/);
  assert.equal(put,undefined);
  assert.equal(s.calls.some(c=>c.method==='DELETE'),false);
});

test('deleting uses the ETag and treats missing events as already deleted', async () => {
  const s=caldavServer(),dav=createCalDav({fetch:s.fetch,now});
  const event:CalendarEvent={id:`acct:${home}:standup-1`,accountId:'acct',calendarId:home,title:'x',start:'',end:'',allDay:false,location:'',description:'',guests:[],remoteId:`${home}standup.ics`};
  s.routes[`GET ${home}standup.ics`]=()=>new Response(standup,{headers:{etag:'"e1"'}});
  s.routes[`DELETE ${home}standup.ics`]=()=>new Response(null,{status:204});
  await dav.deleteEvent(creds,account,event);
  assert.equal(s.calls.find(c=>c.method==='DELETE')?.headers['if-match'],'"e1"');
  s.routes[`DELETE ${home}standup.ics`]=()=>new Response(null,{status:404});
  await dav.deleteEvent(creds,account,event);
  delete s.routes[`GET ${home}standup.ics`];
  const before=s.calls.filter(c=>c.method==='DELETE').length;
  await dav.deleteEvent(creds,account,event);
  assert.equal(s.calls.filter(c=>c.method==='DELETE').length,before,'a 404 on load needs no DELETE');
  await assert.rejects(dav.deleteEvent(creds,account,{...event,remoteId:undefined}),/no calendar server address/);
});

test('errors: a rejected password is certain, network trouble and 5xx are uncertain', async () => {
  const denied=server({'PROPFIND https://caldav.example.test/.well-known/caldav':()=>new Response('no',{status:401})});
  await assert.rejects(createCalDav({fetch:denied.fetch}).verify(creds),(e:CalDavError)=>e instanceof CalDavError&&e.status===401&&!e.uncertain&&/rejected the password/.test(e.message)&&!e.message.includes('app-pass'));
  const offline=(async()=>{throw new TypeError('fetch failed');}) as unknown as typeof fetch;
  await assert.rejects(createCalDav({fetch:offline}).listCalendars(creds,account),(e:CalDavError)=>e.uncertain&&e.status===undefined);
  const slow=(async()=>{throw Object.assign(new Error('timed out'),{name:'TimeoutError'});}) as unknown as typeof fetch;
  await assert.rejects(createCalDav({fetch:slow}).verify(creds),(e:CalDavError)=>e.uncertain&&/in time/.test(e.message));
  const s=caldavServer();
  s.routes[`REPORT ${home}`]=()=>new Response('busy',{status:503});
  await assert.rejects(createCalDav({fetch:s.fetch,now}).listEvents(creds,account),(e:CalDavError)=>e.uncertain&&e.status===503);
  const insecure=server({'PROPFIND https://caldav.example.test/.well-known/caldav':()=>new Response(null,{status:302,headers:{location:'http://caldav.example.test/'}})});
  await assert.rejects(createCalDav({fetch:insecure.fetch}).verify(creds),/insecure/);
  assert.equal(insecure.calls.length,1);
});
