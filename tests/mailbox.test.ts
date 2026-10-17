import test from 'node:test';
import assert from 'node:assert/strict';
import {createDemo} from '../src/engine/demo';
import {bookmarkLeavesList,isBookmark,isHomeLow,isHomeNew,threadInView} from '../src/shared/mailbox';
import type {Thread} from '../src/shared/types';

const demo=createDemo(new Date(2026,9,15,12));
const byId=(id:string)=>demo.threads.find(thread=>thread.id===id)!;

test('bookmarked new mail lives in Bookmarks, not Home or the low-importance bundle',()=>{
  const garden=byId('garden');
  const design=byId('design');
  const delivery=byId('delivery');
  const review=byId('review');
  assert.equal(garden.bookmarked,true);
  assert.equal(garden.status,'new');
  assert.equal(isHomeNew(garden),false);
  assert.equal(isBookmark(garden),true);
  assert.equal(threadInView(garden,'home'),false);
  assert.equal(threadInView(garden,'later','bookmarks'),true);
  assert.equal(isHomeNew(design),true);
  assert.equal(isBookmark(design),false);
  assert.equal(isHomeNew(review),false);
  assert.equal(isHomeLow(delivery),true);
  assert.ok(!demo.threads.filter(isHomeNew).some(thread=>thread.bookmarked));
  assert.ok(!demo.threads.filter(isHomeLow).some(thread=>thread.bookmarked));
});

test('bookmarking a Home thread files it away; unbookmarking files it out of Bookmarks',()=>{
  const design=byId('design');
  const garden=byId('garden');
  const lunch=byId('lunch');
  assert.equal(bookmarkLeavesList(design,true,'home','todos'),true);
  assert.equal(bookmarkLeavesList(lunch,true,'home','todos'),false,'Later items stay on Home’s ready section');
  assert.equal(bookmarkLeavesList(garden,false,'later','bookmarks'),true);
  assert.equal(bookmarkLeavesList(garden,false,'home','todos'),false);
  const after:Thread={...design,bookmarked:true};
  assert.equal(isHomeNew(after),false);
  assert.equal(isBookmark(after),true);
});
