import {useState} from 'react';
import {Shot} from './Chrome';
import {Segmented} from './Live';

// The same week of demo data as a day, a week and a month: real screenshots, crossfaded when the view changes.
const views=['Day','Week','Month'] as const;
type View=typeof views[number];
const shots:Record<View,{name:string;alt:string}>={
  Day:{name:'calendar-day',alt:'One day in the Aplos Mail calendar: a standup, a team retro and a long prototype session, with all-day events at the top.'},
  Week:{name:'calendar',alt:'A week in the Aplos Mail calendar with events from two accounts, a mini month, the list of calendars and an event found in an email.'},
  Month:{name:'calendar-month',alt:'A month in the Aplos Mail calendar, with each day listing its events and times.'},
};

export function CalendarViews() {
  const [view,setView]=useState<View>('Week');
  return (
    <div className="calendar-views">
      <Segmented label="Calendar view" options={views} value={view} onChange={setView} className="calendar-tabs" />
      <div className="calendar-shot" data-ui>
        {views.map(v=>(
          <div key={v} className={`calendar-frame${v===view?' is-on':''}`} aria-hidden={v!==view}>
            <Shot name={shots[v].name} alt={shots[v].alt} width={1440} height={860} />
          </div>
        ))}
      </div>
    </div>
  );
}
