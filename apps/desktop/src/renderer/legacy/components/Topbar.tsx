import { memo } from 'react';
import { ArrowLeft, CalendarDays, PanelLeft, Search, SquarePen } from '../icons';
import { Button, IconButton, Keys, Tooltip } from '../ui';

type TopbarProps = {
  /** The minimized sidebar's menu, in place of the show-sidebar button. */ menu?: React.ReactNode;
  showSidebarButton: boolean;
  showBack: boolean;
  showActions: boolean;
  /** The Ask pill, shown while the Ask panel is closed. */ showAsk: boolean;
  composeBusy: boolean;
  showSidebar: () => void;
  back: () => void;
  compose: () => void;
  ask: () => void;
  calendar: () => void;
};

export const Topbar = memo(function Topbar({
  menu,
  showSidebarButton,
  showBack,
  showActions,
  showAsk,
  composeBusy,
  showSidebar,
  back,
  compose,
  ask,
  calendar,
}: TopbarProps) {
  return (
    <div className="topbar">
      <div className="topbar-left">
        {menu}
        {!menu && showSidebarButton && (
          <IconButton label="Show sidebar" shortcut="[" icon={PanelLeft} onClick={showSidebar} />
        )}
        {showBack && (
          <IconButton label="Back to list" shortcut="Esc" icon={ArrowLeft} onClick={back} />
        )}
        {showActions && (
          <Button
            variant="ghost"
            className="compose-top"
            icon={SquarePen}
            shortcut="C"
            disabled={composeBusy}
            tooltip={{ content: 'New email' }}
            onClick={compose}
          >
            Compose
          </Button>
        )}
      </div>
      {showActions && (
        <div className="topbar-actions">
          {showAsk && (
            <Tooltip
              content="Ask me anything"
              detail="Tap A to type · hold A to talk"
              shortcut="⌘ J"
            >
              <button className="ask-pill" aria-label="Show Ask" onClick={ask}>
                <Search size={15} />
                <span>Ask</span>
                <Keys combo="A" size="sm" />
                <small>Hold to talk</small>
              </button>
            </Tooltip>
          )}
          {showAsk && (
            <Tooltip content="Calendar" detail="Your day beside your mail" shortcut="⇧ A">
              <button
                className="ask-pill calendar-pill"
                aria-label="Show Calendar"
                onClick={calendar}
              >
                <CalendarDays size={15} />
              </button>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  );
});
