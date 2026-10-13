/**
 * The library page's code behind one dynamic import, so a page can fetch it
 * before navigating to the library. React Router's route prefetch reloads the
 * page when a route module fails to load; a failed import here changes nothing.
 */
export { FilesPage } from "./files-page";
export { loadLibraryPage } from "./navigation-client";
