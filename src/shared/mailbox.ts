import type {Thread, View} from './types';

export type LaterTab='todos'|'bookmarks';

/** Important new mail that still belongs on Home’s New stack. */
export function isHomeNew(thread:Thread){
  return thread.status==='new'&&thread.importance==='important'&&!thread.hiddenFromHome&&!thread.bookmarked;
}

/** Low-importance new mail shown as the Home bundle, not the New stack. */
export function isHomeLow(thread:Thread){
  return thread.status==='new'&&thread.importance==='low'&&!thread.bookmarked;
}

export function isLaterTodo(thread:Thread){
  return thread.status==='later';
}

export function isBookmark(thread:Thread){
  return thread.bookmarked&&thread.status!=='trash'&&thread.status!=='spam';
}

export function threadInView(thread:Thread,view:View,laterTab:LaterTab='todos'){
  switch(view){
    case 'home':return isHomeNew(thread);
    case 'later':return laterTab==='bookmarks'?isBookmark(thread):isLaterTodo(thread);
    case 'low':return isHomeLow(thread);
    case 'needs-reply':
    case 'awaiting-reply':return thread.replyStatus===view&&thread.status!=='trash'&&thread.status!=='spam';
    case 'all':return thread.status!=='trash'&&thread.status!=='spam';
    case 'sent':return thread.messages.some(message=>message.sent);
    case 'trash':
    case 'spam':return thread.status===view;
    default:return false;
  }
}

/** Bookmarking files New/low mail off the current list; unbookmarking files it out of Bookmarks. */
export function bookmarkLeavesList(thread:Thread,nextBookmarked:boolean,view:View,laterTab:LaterTab){
  if(nextBookmarked){
    if(view==='home')return isHomeNew(thread);
    if(view==='low')return isHomeLow(thread);
    return false;
  }
  return view==='later'&&laterTab==='bookmarks'&&isBookmark(thread);
}
