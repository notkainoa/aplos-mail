import {ArrowLeft,Columns2,PanelLeft,RectangleVertical,Search,SquarePen} from '../icons';
import type {Settings} from '../../shared/types';
import {Button,IconButton,Keys,Tabs,Tooltip} from '../ui';

type TopbarProps={
  showSidebarButton:boolean;showBack:boolean;showActions:boolean;showModes:boolean;showAsk:boolean;
  openMode:Settings['openMode'];composeBusy:boolean;
  showSidebar:()=>void;back:()=>void;setOpenMode:(mode:Settings['openMode'])=>void;compose:()=>void;ask:()=>void;
};

export function Topbar({showSidebarButton,showBack,showActions,showModes,showAsk,openMode,composeBusy,showSidebar,back,setOpenMode,compose,ask}:TopbarProps){
  return <div className="topbar">
    <div className="topbar-left">
      {showSidebarButton&&<IconButton label="Show sidebar" shortcut="[" icon={PanelLeft} onClick={showSidebar}/>}
      {showBack&&<IconButton label="Back to list" shortcut="Esc" icon={ArrowLeft} onClick={back}/>}
    </div>
    {showActions&&<div className="topbar-actions">
      {showModes&&<><Tabs variant="segmented" semantics="nav" label="Email open mode" value={openMode} onChange={setOpenMode} items={[
        {id:'stack',label:'Open emails in a stack',icon:RectangleVertical,iconOnly:true,tooltip:{title:'Open emails as a stack',detail:'One card at a time, with Done and Todo close at hand'}},
        {id:'split',label:'Open emails in split view',icon:Columns2,iconOnly:true,tooltip:{title:'Open emails beside the list',detail:'Keep the list in view while you read'}},
      ]}/><span className="toolbar-divider"/></>}
      <Button variant="ghost" className="compose-top" icon={SquarePen} disabled={composeBusy} tooltip={{content:'New email',shortcut:'C'}} onClick={compose}>Compose</Button>
      {showAsk&&<Tooltip content="Ask or search your mail" detail="Tap A to type · hold A to talk"><button className="ask-pill" aria-label="Show Ask" onClick={ask}><Search size={15}/><span>Ask</span><Keys combo="A" size="sm"/><small>Hold to talk</small></button></Tooltip>}
    </div>}
  </div>;
}
