# Vision

Where things are headed once their prerequisites exist. Each item says what is waiting and what to do then.

## Website download page

`apps/web/download/` (aplos.email/download/) is the page every download button should eventually lead to. It detects the visitor's computer, starts the matching download, shows three install steps for that system, and lists every version further down.

**Today it is a preview.** Nothing links to it and it is marked `noindex`; the only way in is typing the URL. Its data in `apps/web/src/release.ts` is sample data (version, date, sizes, and Windows and Linux builds that do not exist). While `release.sample` is `true` the page says it is a preview, and nothing ever downloads: the automatic start and every file button only update the page. Add `?platform=mac-x64` (or `mac-arm64`, `win-x64`, `win-arm64`, `linux-x64`, `linux-arm64`) to the URL to preview another system.

**When the first public release is published:**

1. Feed the page real release data and set `sample` to `false` (see below for how).
2. Point every download button at it: the header's Download button, the two "Download for Mac" buttons on the home page and the footer's Download link all use `releasesUrl` in `apps/web/src/site.ts`. Change that to `/download/`; the privacy and download pages share the same header and footer, so they follow.
3. Remove `<meta name="robots" content="noindex">` from `apps/web/download/index.html`.
4. Offer only what is built. `RELEASING.md` builds macOS only (Apple silicon and Intel), so drop the Windows and Linux cards until those builds exist. The install steps for them are already written.

### Where the release data should come from

Recommended: **fetch it from GitHub at build time, and rebuild the site whenever a release is published.**

- A small script run before `vite build` asks the GitHub API for the newest published release (`GET https://api.github.com/repos/notkainoa/aplos-mail/releases/latest`). It writes the version, `published_at`, the release page URL, and each asset's name, size and `browser_download_url` into a JSON file that `release.ts` reads. The script picks files by name (`-arm64.dmg`, `-x64.dmg`, and so on). If the request fails, the build keeps the last checked-in file instead of breaking.
- The release workflow calls a Vercel Deploy Hook when a release is published (`on: release: types: [published]`), so the site rebuilds within a minute of each release. Drafts never show up, because `releases/latest` ignores them.

Why this rather than the alternatives:

- **Asking GitHub from the visitor's browser** would limit each visitor to 60 requests an hour, show the page before its data arrives, and make every visitor's browser call GitHub's API. The privacy page says the site has no third-party scripts and that only downloads come from GitHub, and this would quietly change that.
- **Linking `releases/latest/download/<file>` with no data at all** needs file names that never change. Release files carry the version (`Aplos-Mail-X.Y.Z-arm64.dmg`), so those links would break with each release unless unversioned copies were also uploaded. Sizes, dates and the list of versions would also be missing.

A static page with build-time data loads instantly, keeps working if GitHub's API is down, and is always as current as the last published release.
