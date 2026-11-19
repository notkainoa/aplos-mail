// The Search page (lane ui-ask, DESIGN §7.9). The shell renders `SearchScreen` for the `{ label: 'Search' }` screen
// (the sidebar's Search row, `/`). It is a page, not an overlay: local results as you type, remote only on Return.
export { SearchScreen, type SearchScreenProps } from './SearchScreen';
export { SearchPage, RESULTS_ID, type SearchPageProps } from './SearchPage';
