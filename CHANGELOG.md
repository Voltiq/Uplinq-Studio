# Changelog

## 1.0.0 — 2026-11-12

FTP Studio is now **Uplinq Studio**.

### Added
- **German**: the whole interface, the error messages from servers and Windows, and the installer. Uplinq
  Studio follows the language of Windows, or the one chosen under *Settings › Language*.
- **Its own title bar**: the window no longer has the Windows frame. The bar shows the app's icon and name,
  the connected site, and the buttons to minimise, maximise and close. Drag it, or the empty parts of the
  toolbar below it, to move the window; double-click it to maximise.
- **Updates**: Uplinq Studio looks for a newer version every time it starts and asks whether to install it.
  *Update now* installs and restarts, *Later* asks again at the next start, *Skip this version* waits for the
  one after it. *Settings › Updates* checks on request.
- **Installer** in English and German. It installs for the current user without administrator rights and
  removes an old FTP Studio copy. Saved sites and settings carry over.

### Changed
- A new icon, in the style of the other Studio apps.

### Fixed
- The ⋯ button of a saved site in the sidebar sometimes did not open its menu: pressing it moved the button
  down by half its height, so a click on its upper half ended on the row behind it.
