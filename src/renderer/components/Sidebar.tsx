import {Archive,ArrowLeft,ArrowRight,CalendarDays,ChevronsUpDown,Clock,CornerUpLeft,FileText,Home,MessageCircle,PanelLeft,Plus,RefreshCw,Send,ShieldAlert,Trash2} from '../icons';
import type {Account,AppState,View} from '../../shared/types';
import {Count,IconButton,Keys,Menu,cx,useMenu,type Icon} from '../ui';

export const sections:{view:View;label:string;icon:Icon;divider?:boolean}[]=[
  {view:'home',label:'Home',icon:Home},{view:'later',label:'Later',icon:Clock},
  {view:'all',label:'All mail',icon:Archive,divider:true},{view:'drafts',label:'Drafts',icon:FileText},{view:'sent',label:'Sent',icon:Send},
  {view:'needs-reply',label:'Needs reply',icon:CornerUpLeft,divider:true},{view:'awaiting-reply',label:'Awaiting reply',icon:MessageCircle},
  {view:'calendar',label:'Calendar',icon:CalendarDays,divider:true},{view:'trash',label:'Trash',icon:Trash2},{view:'spam',label:'Spam',icon:ShieldAlert},
];

export function accountName(account:Account){return account.provider==='demo'?(account.id==='work'?'Work':'Personal'):account.name;}
function accountInitial(account:Account){return (account.provider==='demo'?(account.id==='work'?'W':'P'):account.name[0]||'?').toUpperCase();}

type SidebarProps={
  state:AppState;
  view:View|null;
  count:(view:View)=>number;
  zen:boolean;
  online:boolean;
  syncing:boolean;
  canBack:boolean;canForward:boolean;
  navigate:(view:View)=>void;
  back:()=>void;forward:()=>void;
  sync:()=>void;
  hide:()=>void;
  selectAccount:(id:string)=>void;
  shortcuts:()=>void;
  onError:(error:Error)=>void;
};

export function Sidebar({state,view,count,zen,online,syncing,canBack,canForward,navigate,back,forward,sync,hide,selectAccount,shortcuts,onError}:SidebarProps){
  const accounts=useMenu();
  const current=state.accounts.find(a=>a.id===state.selectedAccountId);
  const shown=current?[current]:state.accounts.slice(0,2);
  const demoOnly=state.accounts.every(a=>a.provider==='demo');
  const status=!online||state.sync.busy||!!state.sync.error;
  return <aside className="sidebar">
    <div className="sidebar-titlebar">
      <IconButton label="Hide sidebar" shortcut="[" icon={PanelLeft} onClick={hide}/>
      <div className="actions">
        <IconButton label="Refresh mail" icon={RefreshCw} iconSize={14} disabled={syncing} className={syncing?'is-syncing':undefined} onClick={sync}/>
        <IconButton label="Back" icon={ArrowLeft} disabled={!canBack} onClick={back}/>
        <IconButton label="Forward" icon={ArrowRight} disabled={!canForward} onClick={forward}/>
      </div>
    </div>
    <button className={cx('account-trigger',accounts.open&&'is-open')} aria-label="Switch account" aria-haspopup="menu" aria-expanded={accounts.open} onClick={accounts.toggle}>
      <span className="account-stack">{shown.map(a=><span key={a.id} className="account-avatar" style={{background:a.color}}>{accountInitial(a)}</span>)}</span>
      <span className="account-name">{current?accountName(current):'All accounts'}</span>
      <ChevronsUpDown size={15}/>
    </button>
    <Menu open={accounts.open} anchor={accounts.anchor} onClose={accounts.close} placement="bottom-start" matchWidth label="Accounts" className="account-menu" onError={onError} groups={[
      [{label:'All accounts',checked:state.selectedAccountId==='all',onSelect:()=>selectAccount('all')},
       ...state.accounts.map(a=>({label:accountName(a),hint:a.email,leading:<span className="account-dot" style={{background:a.color}}/>,checked:a.id===state.selectedAccountId,onSelect:()=>selectAccount(a.id)}))],
      [{label:'Manage accounts',icon:Plus,onSelect:()=>navigate('settings')}],
    ]}/>
    <nav className="main-nav" aria-label="Mailboxes">{sections.map(({view:id,label,icon:NavIcon,divider},index)=>{
      const value=count(id);
      return <div key={id} className={divider?'nav-divider':undefined}>
        <button className={cx('nav-item',view===id&&'active')} aria-current={view===id?'page':undefined} onClick={()=>navigate(id)}>
          <NavIcon size={18}/><span className="nav-label">{label}</span>
          {index<9&&<Keys combo={'⌃ '+(index+1)} size="sm" className="nav-keys"/>}
          {(!zen||id==='home')&&value>0&&<Count value={value} className="nav-count"/>}
        </button>
      </div>;
    })}</nav>
    <footer className="sidebar-footer">
      {status&&<div className="sidebar-status"><span className={cx('sync-dot',(!online||state.sync.error)&&'offline',state.sync.busy&&'busy')}/><span>{!online?'Available offline':state.sync.busy?'Syncing mail…':'Sync needs attention'}</span></div>}
      <button className={cx('footer-link',view==='settings'&&'active')} onClick={()=>navigate('settings')}>Settings</button>
      <button className="footer-link" onClick={shortcuts}>Keyboard shortcuts</button>
      {demoOnly&&<span className="footer-note">Demo mail</span>}
    </footer>
  </aside>;
}
