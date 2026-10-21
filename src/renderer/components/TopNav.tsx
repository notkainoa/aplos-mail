import {memo} from 'react';
import {CalendarDays,Gear,Keyboard,MoreHorizontal,Send,ShieldAlert,Trash2} from '../icons';
import type {AppState,View} from '../../shared/types';
import {IconButton,Menu,Tabs,Tooltip,cx,useMenu} from '../ui';
import {AccountSwitcher} from './Sidebar';

const tabs=[{id:'home',label:'Home'},{id:'later',label:'Later'},{id:'all',label:'All mail'},{id:'drafts',label:'Drafts'}] as const;
type TabView=typeof tabs[number]['id'];
const moreViews=[{view:'sent',label:'Sent',icon:Send},{view:'trash',label:'Trash',icon:Trash2},{view:'spam',label:'Spam',icon:ShieldAlert}] as const;

type TopNavProps={
  state:AppState;
  view:View|null;
  counts:Partial<Record<View,number>>;
  zen:boolean;
  navigate:(view:View)=>void;
  selectAccount:(id:string)=>void;
  onError:(error:Error)=>void;
};

/** The top bar layout's navigation: account, the main mailboxes as tabs, Calendar, and the rest under More. */
export const TopNav=memo(function TopNav({state,view,counts,zen,navigate,selectAccount,onError}:TopNavProps){
  const more=useMenu();
  const inMore=moreViews.some(m=>m.view===view);
  return <nav className="top-nav" aria-label="Mailboxes">
    <AccountSwitcher compact state={state} navigate={navigate} selectAccount={selectAccount} onError={onError}/>
    <Tabs variant="segmented" semantics="nav" label="Mailboxes" className="top-nav-tabs" value={(view??'') as TabView} onChange={navigate}
      items={tabs.map(({id,label})=>{const value=counts[id]??0;return {id,label,count:(!zen||id==='home')&&value>0?value:undefined};})}/>
    <IconButton label="Calendar" shortcut="⌃ 6" icon={CalendarDays} active={view==='calendar'} className="top-nav-icon" onClick={()=>navigate('calendar')}/>
    <IconButton label="More mailboxes" icon={MoreHorizontal} active={inMore||more.open} className="top-nav-icon" aria-haspopup="menu" aria-expanded={more.open} onClick={more.toggle}/>
    <Menu open={more.open} anchor={more.anchor} onClose={more.close} placement="bottom-start" label="More mailboxes" onError={onError}
      groups={[moreViews.map(m=>({label:m.label,icon:m.icon,checked:view===m.view,onSelect:()=>navigate(m.view)}))]}/>
  </nav>;
});

type CornerProps={settingsOpen:boolean;online:boolean;busy:boolean;error:boolean;settings:()=>void;shortcuts:()=>void};

/** Settings and the shortcut guide as quiet icons in the window's bottom-left corner, with sync status beside them. */
export const CornerTools=memo(function CornerTools({settingsOpen,online,busy,error,settings,shortcuts}:CornerProps){
  const status=!online?'Available offline':busy?'Syncing mail…':error?'Sync needs attention':'';
  return <div className="corner-tools">
    <IconButton label="Settings" shortcut="⌘ ," placement="top" icon={Gear} active={settingsOpen} onClick={settings}/>
    <IconButton label="Keyboard shortcuts" shortcut="?" placement="top" icon={Keyboard} onClick={shortcuts}/>
    {status&&<Tooltip content={status} placement="top"><span className="corner-status" tabIndex={0} aria-label={status}><span className={cx('sync-dot',(!online||error)&&'offline',busy&&'busy')}/></span></Tooltip>}
  </div>;
});
