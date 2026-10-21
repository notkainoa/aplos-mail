import {memo} from 'react';
import {ArrowLeft,PanelLeft,Search,SquarePen} from '../icons';
import {Button,IconButton,Keys,Tooltip} from '../ui';

type TopbarProps={
  /** The top bar layout's navigation, at the start of the bar. */ nav?:React.ReactNode;
  showSidebarButton:boolean;showBack:boolean;showActions:boolean;
  /** The Ask pill, shown while the Ask panel is closed. */ showAsk:boolean;
  composeBusy:boolean;
  showSidebar:()=>void;back:()=>void;compose:()=>void;ask:()=>void;
};

export const Topbar=memo(function Topbar({nav,showSidebarButton,showBack,showActions,showAsk,composeBusy,showSidebar,back,compose,ask}:TopbarProps){
  return <div className="topbar">
    <div className="topbar-left">
      {showSidebarButton&&<IconButton label="Show sidebar" shortcut="[" icon={PanelLeft} onClick={showSidebar}/>}
      {nav}
      {nav&&showBack&&<span className="toolbar-divider"/>}
      {showBack&&<IconButton label="Back to list" shortcut="Esc" icon={ArrowLeft} onClick={back}/>}
    </div>
    {showActions&&<div className="topbar-actions">
      <Button variant="ghost" className="compose-top" icon={SquarePen} shortcut="C" disabled={composeBusy} tooltip={{content:'New email'}} onClick={compose}>Compose</Button>
      {showAsk&&<Tooltip content="Ask me anything" detail="Tap A to type · hold A to talk" shortcut="⌘ J"><button className="ask-pill" aria-label="Show Ask" onClick={ask}><Search size={15}/><span>Ask</span><Keys combo="A" size="sm"/><small>Hold to talk</small></button></Tooltip>}
    </div>}
  </div>;
});
