# skein

## 0.1.16

### Patch Changes

- 9be0e31: try to fix flac playback in animaniac widget; scroll share modal; fix narthex localStorage bug

## 0.1.15

### Patch Changes

- d6d2564: more animaniac and snatching bug fixes; add more diagnostic stuff; copy/paste widgetz between canvasz;
- 9ede661: audio clip volume adjustmentz
- 0d62cc6: improve animaniac clip segment labelz + add audio waveformz
- fb10a46: tidy export audio mixdown to handle one request at a time, and then also just drop audio file into a new canvas widget rather than download
- f982db0: multi-select animaniac segment clipz to move 'em
- ad2ace8: drop audio files on empty voice recordingz to use as mouth animation audio

## 0.1.14

### Patch Changes

- 34ed925: bump up animaniac widget drop loggin' to catch any issuez

## 0.1.13

### Patch Changes

- d086ee8: animaniac widget 🥩

## 0.1.12

### Patch Changes

- 8218d9f: handle stfu + videoz inna bin
- 39fe4e3: try to improve doodle widget input; add new pen shape; improve pen pointerType input

## 0.1.11

### Patch Changes

- 71fee17: try to improve doodle widget + prop tray scale

## 0.1.10

### Patch Changes

- e8e0e16: add tts widget
- 00241ab: new stfu + tts widgetz

## 0.1.9

### Patch Changes

- 29991a2: improve local filez widget: add type labelz + filter, add thumbnail imagez, fix date formatting, improve pagination
- 6e86eba: add xs and xxl SLOT_SCALE_MULTIPLIERS
- 956c969: re-work bin size scale; improve widget resize handle so easier to use zoomed out; fix bin cell label text; try to improve snatch all ui/ux;

## 0.1.8

### Patch Changes

- f492d8e: handle playing audio + video filez better
- 670a98b: add drag'n drop handlerz for droppin' external filez
- 3390ce1: filez widget showz local filez
- 9af1d29: peerz that have file should re-process on file type domain changez
- 5214d8e: scale up bin sizes and improve cell size calculationz to better handle cell borderz

## 0.1.7

### Patch Changes

- 0322606: stub out file canvas refz data; let user specify domain for unknown filez;
- d61cb04: file transfer ui;

## 0.1.6

### Patch Changes

- dfdc725: seperate sfx settingz; tidy'n settingz view; add more android permissionz; fix broken alias setting;

## 0.1.5

### Patch Changes

- 5a99c04: try to improve share canvas dialog; tidy tumlus; bump tomb/lib/ depz;
- 194999f: bump tomb 0.2.8 && fix blob request bao calc; dedupe file holderz list; try to fix tumulus glibc version for raspi linux-arm64 buildz;
- 9d96b58: try to handle cold-open share linkz better
- 5cd73e5: open social widget for new userz
- b69f941: load video thumbz better
- 14bddd4: lots of minor stuff: add title to file widgetz (so bin labelz better); try again to sort hub nodez in share dialog; yank file widget's `→ disk` button and fix pause button position; fix copy node id button style; peedeeeff takez more file formatz with pandoc + typst; hub does more processing (for peedeeeff, etc).
- a6da7ae: refactor doc open to be signal-based rather than timer-based; but also keep the timer for a number of call sitez so that it doesn't hang forever
- c57af7d: add thumbnailz to widgetz to show in binz; add border and cell dividerz to binz; fix click area of "click to add" file + peedeeeff widgetz and try to make sure only creator can add first file; prevent autohide when layer flyout is open; fix unfurl text encoding bugz; persist narthex zoom + position when navigating away + back; try to get thumbnail image from videoz + pdfz in tauri app;
- 848dd49: tumulus use sqlite WAL and add file loggin'
- 39ebcbe: tidy'n the bin widget layout and such- make tidy re-size content, cells fit better, boost resolution of voice recordingz + doodles and many other aesthetic improvementz
- 96efdd2: use cwd tumulus-data for data dir of not otherwise specified
- 82cc9a1: handle gifz better; try to improve video + audio tumbnail gen;
- a703a5b: some backfill migrationz; add setup file logger;

## 0.1.4

### Patch Changes

- ecb9bf1: try to improve peedeeeff magick + gs bin path lookupz
- 4873abb: fix audio + voice recording file blob sync between tauri <-> browser
- a6e8e33: fix click handler on lower left corner peer count that opens canvas info
- c3af5af: use identity info (like avatar + online status) throughout ui; improve share + hub flowz;
- f9f346a: gossip about pending friend requestz to get profile info from friendz and help deliver friend req
- abb78b1: yank hub stuff from tauri app + rework settingz window; fix canvas loading ui;

## 0.1.3

### Patch Changes

- a171601: `x` to close dismissible widgetz; check friend online status again on profile view; disable manage hub btn if hub is offline;
- 7fc12f0: add hyperlinkz to markdown parser
- e476b23: fix audio+voice recordingz tauri blob storage bugz; fix peedeeeff magick path issuez

## 0.1.2

### Patch Changes

- 036b37b: move reliquary (storage stuff), haruspex (user stuff), and midden (WASM stuff) into their own library (over in tomb). try to improve acl stuff and file blob sharing stuff. CI stuff: add linting and tests to PR checks, add changesets + build stuff like tomb does.
- c77755d: e2e test coverage reporting; yank friend's canvases bin; make own canvases bin not hidden; try to improve is_hub checkz; improve make scriptz; add initial loading spinner;
- 546f44e: try to improve the voice recording mouth animation
