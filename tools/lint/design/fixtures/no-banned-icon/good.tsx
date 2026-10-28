import { Bookmark, Clock, Check, Trash2, Reply, Calendar, MessageSquare, Restart, ArrowUpFromLine } from 'lucide-react';
import { StartIcon } from './icons';
import { Button } from 'react-aria';

export function View() {
  return (
    <div>
      <Bookmark />
      <Clock />
      <Check />
      <Trash2 />
      <Reply />
      <Calendar />
      <MessageSquare />
      <Restart />
      <ArrowUpFromLine />
      <StartIcon />
      <Icon name="bookmark" />
      <Icon name="text.bubble" />
      <Icon name="square.and.pencil" />
      <Icon name="checkmark.circle" />
      <span>Start here. The doctor stays.</span>
      <Button aria-label="Mark as starred later" />
    </div>
  );
}

export const labels = ['Bookmarks', 'Restart', 'Starter'];

function Icon(props: { name: string }) {
  return <i {...props} />;
}

import { useStarred } from './hooks';
export const state = <span data-state="star" />;
export const tab = { name: 'star', start: 1 };
export const sheet = <DynamicIcon name="bookmark" />;
