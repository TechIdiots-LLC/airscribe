# Changelog

## master
### ✨ Features and improvements
- _...Add new stuff here..._

### 🐞 Bug fixes
- _...Add new stuff here..._

## 0.8.0
### ✨ Features and improvements
- Admin → Findings → Roads brings in towns, named places (businesses, schools) and addresses with the roads: from the map's tiles (towns and places), from OpenStreetMap, or from a file. A file can be addresses alone, OpenAddresses-style (number, street, city), and leaves the roads as they were. `tools/roads-from-osm.sh` now exports all of them
- Findings gives the model the towns and businesses said near the channel ("Family Dolar" comes back as Family Dollar, "Grimfield" as Brimfield), looks at a town's roads when one a way off is named, and checks the house numbers said against the addresses: "1616 Roxbury Street isn't there (its numbers run 16 to 120)". A house number that's really the time said, on a street without that number, is taken out as the time
- The Map's Roads mentioned puts a dot at the house when an address's number is among those imported, and at a named place mentioned (a business, a school); an address ending in a town is looked for around that town rather than the channel
- Admin → Findings → Roads → Download and read: give an OpenStreetMap extract's address (a state's `.osm.pbf` from Geofabrik) and AirScribe downloads it, cuts the channels' area out with osmium and reads its roads, towns, places and addresses, with no PC step. The package now recommends `osmium-tool`, and the LXC template has it

### 🐞 Bug fixes
- Findings gives the model the likeliest roads first: a road said by its whole name ("Walnut Street") is no longer crowded out by "A Street", "The Boulevard" and every "Main …" variant, and the new transmission's roads come before those of the earlier ones

## 0.7.1
### ✨ Features and improvements
- Admin → Findings → Forget the key removes a saved API key, for a server that doesn't want one (Ollama's own port rather than Open WebUI's)

### 🐞 Bug fixes
- Findings → The day so far sums up the latest hours first, so today's fill in soon after an update or a while off rather than after the last 36 hours'. An hour the model fails on waits 30 minutes instead of stopping every hour after it
- Findings with gpt-oss asks it to think as little as it can: it can't turn its thinking off, as AirScribe asks other models to
- Admin, Findings and Channels show an error when a proxy in front of AirScribe gives up waiting (a 502 or 504), rather than a blank line
- Findings stops a model's answer at 2048 tokens (8192 for an hour of the day so far), so one going round in circles fails in seconds instead of holding the server for minutes; and a model that doesn't answer in time is said to be that, not "can't reach"

## 0.7.0
### ✨ Features and improvements
- Findings knows local terms: Admin → Findings → Local terms says what a code or word means here ("Code 4", "Q5", "Section 12"), and a transmission that says one is read with it. Codes said on the air ("Code 5", "Signal 23", "Unit 26", "10-4") and words the model didn't know are collected, and once one has been said a few times the model works out what it likely means from those transmissions. That's a guess, given to the model marked as unconfirmed, until an admin accepts or rejects it. Entries can be kept to some channels, and imported or exported a line each
- Findings → The day so far: each hour, once it's over and read, the model sums up what happened in it (an item per call or conversation, each opening the findings it came from), and writes the day's overview again, for every radio and for each. Pick a day, a radio or a channel. On by default with Findings; Admin → Findings → Sum up each hour turns it off
- Findings can have a note: an admin writes what the model got wrong ("the car is grey, not great") under a finding, everyone sees it, and the model is given it with the finding whenever it's listed with a later transmission, and when the transmission is read again
- A footer on every page: AirScribe's version (for the signed-in), © TechIdiots LLC, and the privacy policy and terms. The terms are a fuller user agreement, and Admin → This server names who runs the server and how to reach them on both pages
- What you choose on the pages (the Map's base map, layers, tab and hours, Roads on the map, Hide silent…) is kept with your account, so it follows you to another browser or to the server's other address (docs/accounts.md#choices-on-the-pages)
- The Map's Roads on the map (Findings tab) is on by default
- A privacy policy and terms of use, at /privacy.html and /terms.html, readable signed out and linked from the sign-in page and the public view: what an account, a linked Google (or GitHub, Discord, Facebook) sign-in and cookies keep, for a sign-in provider's consent screen

### 🐞 Bug fixes
- Findings reads a time dispatch logs ("in route 1447" at 2:47 PM) as a time: the model is told it, and an address or road that's only a time ("Route 1447") is left out, shown as "Left out, a time"
- Two-step verification is a second step only: a passkey no longer signs anyone in on its own (Sign in with a passkey is gone), and signing in is a password or a linked account. The passkey or code is asked for when the radios or Admin need it, and at sign-in too only for accounts that tick Your account → Two-step verification → Ask when I sign in too

## 0.6.0
### ✨ Features and improvements

### 🐞 Bug fixes
- Findings asks for a summary of what happened, not the words quoted back ("The speaker says 'Receive one.'"): an acknowledgment or a bare unit number is left empty
- Findings doesn't give a ham channel the roads near it: a chat about equipment sounded like two dozen roads, and the model reported some
- Findings hears a clip again far less often, and only with the words that might be misheard. The model's ask counts only when the transmission has that kind of thing: a plate read out, a house number, a road. It ran on 478 of 650 transmissions, mostly "plate" for "thank you"; replayed with the check, it would have run on 112. Whisper is told only the alphabet or the roads near, with no "Copy. En route. Received." first (which turned "Receive 11" into "Received"), and what only the second hearing heard isn't kept, except a plate it finishes
- Findings reads plates more carefully. A plate said twice ends where its repeat begins (4FYV34, not 4FYV344). A tone ("PL 114.8"), a name spelled out, or a unit said twice isn't read as one, and of an engine's stray reading (H6PTP38 beside 6PTP38) the one more engines read is kept. On ham channels only a plate after "reg" or "plate" counts. A plate the model writes must look like one; units, apartments and callsigns it put in plates are shown as "Left out, not a plate"
- Findings: another radio's transmission counts as the same call only when the two were on the air together. With Same call within set wide, the next call on the frequency became an "other reading", and its names were reported for a "thank you"
- Speak new findings no longer says a call twice: a summary much like one said in the last three minutes is skipped (a dispatcher's repeat, or the same call on two channels), and only one AirScribe tab in a browser speaks

## 0.5.0
### ✨ Features and improvements
- Each page has its own address (`#/map`, `#/admin`, ...): a reload stays on the page, and Back and Forward move between pages
- Findings reads plates spelled out on the radio itself ("Mass Reg 4, Sierra, Sierra, Romeo 33" is 4SSR33), tells the model, and keeps them when the model leaves them out
- Findings only keeps what the transmission said: an address, name, vehicle or unit the model copied from the transmissions before it is taken out, and shown as "Left out, not said in it"
- Findings can have a clip heard again when a plate, number or road seems misheard: whisper-server is told the words to expect (the phonetic alphabet, or the roads near), and the transmission is read again with what it heard. Admin → Findings sets how many times (once by default) and with which engine
- Findings works out each channel's service (from Uniden's database, its name, or what its findings mostly said), tells the model, and uses it over an answer of amateur or other: a dispatcher reading "Sierra Alpha" is no longer a ham
- Findings' instructions end with worked examples, and ask for specific summaries: a ham conversation is summed up with the equipment, band or net it's about, in up to two sentences
- Findings doesn't read a transmission the default engine heard no words in, unless another radio or two other engines did: one engine's words over static were mostly noise, and came back with roads
- Admins can export the last hours of findings as JSON, with every engine's transcript, the prompt sent, the answer and what was left out, to share when looking into what the model gets wrong
- The Findings tab and the Map's Findings tab can show one radio's or one channel's findings; the roads on the map follow the Map's choice
- Findings gives the model earlier findings only from the same channel, or from another that names a unit, road, address or plate the transmission says, not every channel's

### 🐞 Bug fixes
- Findings: new findings show at the top of the open Findings tab within a few seconds, not after leaving and coming back
- NVIDIA's Parakeet TDT runs through sherpa-onnx: set `"family": "nemo-transducer"` (the `parakeet-tdt` model id does it). As `transducer` every clip failed with "'vocab_size' does not exist in the metadata"

## 0.4.0
### ✨ Features and improvements

### 🐞 Bug fixes

## 0.3.0
### ✨ Features and improvements
- Map → Roads mentioned can show the last 15 or 30 minutes
- Findings has its own tab, which viewers see too (never the public view); its settings and the watch list stay with admins
- Findings shows what was sent to the model with each transmission, and the model's instructions
- Findings tells the model when a transmission came through static, and marks those in the list
- The Map has a Findings tab: what was found in the hours chosen, each able to frame the roads it mentions; Roads on the map moved there
- Findings asks the model which service is talking (police, fire, EMS, public works, amateur); roads on the map are drawn in that service's colour, fading with age
- Findings gives the model the other channels' last five minutes as context, as well as the same channel's, and the same channel's last five rather than three
- Findings waits for every speech engine and gives the model each one's reading, and another radio's copy of the same transmission (same frequency, within 5 s); a clip only another engine heard words in is read too; callsign channels are amateur
- Admin → Findings sets what goes to the model with each transmission: how far back, how many from this channel and from others, when another radio's copy is the same call, and how long to wait for the other speech engines
- Map → Channels can hide every channel, or each one by itself, from the map (remembered in this browser); a hidden channel no longer groups with those near it
- Findings shows the tokens each prompt and answer took and how long, and Admin → Findings the biggest prompt of the last day
- Findings gives the model the last few findings (any channel, last 15 minutes), and a later transmission can correct an earlier finding's address, plate, road, unit and so on: both are marked, the Map follows, and the watch list looks again
- Findings → Speak new findings reads each new finding's channel and summary aloud in the browser, after any clip that's playing; also on the Map's Findings tab
- Findings reads a call heard by two radios once, with the other radio's copy attached (shown as "also heard", with its clip), so it isn't found twice or its roads counted twice
- Channels → Add channels… → Ham, from Uniden's database: the 2 m and 70 cm frequencies the scanner's database lists near home, with mode and tone; repeaters get the band plan's offset; tick them or fill the region with the nearest, then write to the radio. Re-import Uniden's database to get modes and tones

### 🐞 Bug fixes
- The Map groups channels less eagerly: a long name is cut short beside its dot (in full on hover or on the air), and only what's drawn keeps channels apart

## 0.2.0
### ✨ Features and improvements
- **Findings (Admin → Findings), off until an admin turns it on:** a language model on your own server (llm-lxc's
  Ollama, or any OpenAI-style one) reads each transcript, with its channel's last few minutes, and picks out the
  addresses, roads, plates (a phonetic alphabet read out becomes letters), vehicles, people and units, the kind of
  call and a one-line summary. A watch list of plates, streets, names or phrases is checked against the transcript
  and what was found, and a match can be posted to a webhook (Home Assistant). Only admins see any of it, behind
  Admin's own check; it's never in the feed, the event stream, exports or the public view, and it's deleted after 30
  days by default (docs/findings.md).
- **Uniden's database for Find, and Find all:** Admin imports the database Uniden's scanners carry from the SD card's
  `BCDx36HP/HPDB` folder, as a .zip (Windows' Send to → Compressed folder) or the folder itself, the states ticked only.
  The Map's Find then looks there too, with RadioReference or without it: by the channel's name, which a scanner takes
  from that database, its frequency, talkgroup and the department the scanner gave, near home. **Find all** looks up
  every channel not placed, ticks those Uniden's database is sure of, and places the ticked together
  (docs/radioreference.md#from-unidens-database).
- **Findings → Roads:** the roads around the channels, read from the map's own OpenMapTiles tiles (the same roads an
  OpenMapTiles router uses), fetched from OpenStreetMap, or imported from a GeoJSON file
  (`tools/roads-from-osm.sh` cuts one from any `.osm.pbf`, the planet included). The model is told the roads near
  the channel whose names sound like something said, so a misheard road comes back as the one that's there; and the
  roads mentioned light up on the Map for admins (**Roads mentioned**), near their channel, with a dot where an
  address names a corner, and what was said about each a click away (docs/findings.md#roads).
- **NVIDIA GPUs:** `tools/install-nvidia-libs.sh` installs the Proxmox host's NVIDIA driver version's libraries in the
  container (they must match), and docs/proxmox.md sets up the host and the container for an NVIDIA card, with
  whisper.cpp built with CUDA behind the `whisper-server` engine (OpenVINO runs only on Intel hardware).
- **One address:** visitors who aren't signed in see the public view (what's published, behind the delay) with a
  **Sign in** button, on the same address as the console; `/#signin` goes straight to signing in. `adminPort` and
  `adminHost` are gone: an old settings file that sets them gets a warning, and the console is on `port`. Signed
  out, every API route but signing in and `/api/public/...` answers 401 (docs/publishing.md#one-address).
- **Two-step verification:** a passkey (Face ID, Touch ID, Windows Hello, a phone or a security key) or an
  authenticator app's code, with ten recovery codes, set up under Your account. An account that has it signs in with
  its password and then a passkey or code (**Remember this browser** skips that for 30 days), or with a passkey alone.
  Admins need it: controlling the radios wants a step in that session, and Admin, which changes settings, a check of
  its own that lasts 12 hours. Admin → Users resets another account's. The settings file's password passes both, so
  it's taken only from the local network; `twoStep.required: false` turns the requirement off. Passkeys work on the
  HTTPS address (`trustProxy` behind a proxy); the app's codes anywhere. Scripts use API tokens (docs/two-step.md).
- **`bumble` Bluetooth backend:** reaches radios through a USB dongle that Bumble drives directly, for an LXC
  container, where the system's Bluetooth can't work, and in time Windows. The radio handling is the BlueZ backend's,
  unchanged; only the Bluetooth underneath differs. Set `sidecar.backend` to `bumble`, `sidecar.python` to a Python
  with Bumble, and `sidecar.transport` to the dongle (docs/proxmox.md). In an unprivileged Proxmox container it
  connected to a UV-Pro, read its battery and channel names, and recorded its transmissions; one dongle served two
  UV-Pros at once.
- **`tools/probe-bumble.py` in a container:** in an unprivileged Proxmox container it paired with a UV-Pro, found
  its channels and captured its audio (docs/bluetooth.md; docs/proxmox.md has the steps). A capture is also saved
  as raw SBC, which ffmpeg turns into a WAV, and a dongle or channel that won't open says why.
- **Rename a radio:** a Rename button on each radio, so two of the same model, which scan in with the same name, can
  be told apart. The feed, the radio filter and exports show the new name, past transmissions included.
- **The feed pages, and searches everything:** 50 transmissions at a time with **Load older** and a count ("Showing
  50 of 1,234"). The search box and the radio filter ask the server, so they cover the whole history rather than
  the rows that happened to be loaded, and Export takes everything they match. A transmission arriving or being
  transcribed redraws only its own row, so a clip being played isn't stopped by another arriving.
- **Radio controls:** an admin's **Controls** on a connected radio read its region (by name), channel, dual watch and
  second channel, scan, squelch, volume and GPS fix from the radio, and change any of them. A settings change sends
  back the radio's own block with only that changed, then reads it again and says if the radio didn't take it.
  Changing region reads that region's channels. A radio with a GPS fix appears on the Map. Command layouts follow
  HTCommander's protocol reference.
- **Map:** a view with each channel where an admin placed it (Place, then click the map; drag to move). A channel
  lights up while one of the radios is receiving on it and pulses when its transmission has been saved; its popup
  shows what it said lately and opens the feed on it. Channels that would cover each other, such as several at one
  public safety complex, are drawn as one marker with a count and each name, a name lighting up while its channel is
  on the air; clicking it zooms in until they part, or lists them where they share a spot. An admin can **Move** a
  channel with a click too, for one placed on top of another. Base maps are MapLibre styles (`map.styles`), by default the
  colour-relief, dark colour-relief and OpenStreetMap styles from tiles.wifidb.net; a dark browser starts on the dark
  one, and the choice is remembered. MapLibre GL JS 6 is served by AirScribe itself (public/vendor).
- **What's said, beside the Map:** the Map's side lists the transmissions as they come in, newest first, each with a
  play button; while one plays its channel is marked on the map, pointing at a row points at its channel, and a
  channel's name flies to it. The list can keep to one radio (so a radio scanning amateur channels, whose
  conversations run long, can be left out while watching one scanning emergency services), to the channels in view,
  or to channels chosen from a popup (**Show in the list**). What a channel says also shows at it on the map for a
  few seconds (**Words on the map**). Placing channels moved to the side's **Channels** tab. `/api/transmissions`
  takes `channel` more than once, for any of several channels.
- **Find a channel's place, from RadioReference:** an admin's **Find** looks a channel's frequency up in the
  RadioReference database, in the county of a ZIP code (the state, if the county has nothing), and offers where the
  FCC licence says its transmitter is, then the area RadioReference gives the listing, best match for the channel's
  name first and numbered on the map; **Place here** puts the channel there. It signs in with a RadioReference
  Premium account and an app key, set in **Admin → RadioReference**, where the password and key are never shown
  again (docs/radioreference.md). Tested against a stand-in for the API; with a real account, signing in and the
  ZIP code lookup work, and Find on real listings is still to be tried.
- **Accounts and invites:** each person can have their own account, a viewer (reads everything, changes nothing)
  or an admin. **Admin → Users** adds them, changes their role, sets a password, signs them out, turns them off or
  deletes them, and makes **invite links**: one account each, with its role, for up to 30 days, kept only as a hash.
  The name in the header opens **your account**, to change your password or sign out everywhere else. Five wrong
  passwords lock an account for 15 minutes. Sign-ins now outlast a restart or an update. The settings file's
  password and API tokens keep working beside accounts, the password as a way back in (docs/accounts.md).
- **Sign in with Google, GitHub, Discord or Facebook:** link one under your account (with your password) and sign
  in with it instead, as in WifiDB and tippr. An outside account only ever signs in to the account that linked it,
  never matched by e-mail; one not linked yet is linked by signing in with your password, within 10 minutes. Each
  provider is turned on in **Admin → Sign-in providers** with its own OAuth app's client ID and secret, and the page
  shows the redirect URI to register (docs/linked-logins.md). OAuth 2 code flow on the server, PKCE for Google.
- **A radio's channels, backed up and written:** an admin's **Channels** on a connected radio shows every slot of a
  region as the radio has it (frequencies, tones, FM or AM and bandwidth, transmit on or off, scan), in any region.
  **Back up this region** keeps it, and **Put back** writes every slot back exactly as it was. A write backs the
  region up first and reads each channel back from the radio to check it took. AirScribe writes channels that
  transmit only in the 2 m and 70 cm ham bands; anything else is receive-only (docs/channels.md). Command layouts
  follow HTCommander; tested against the simulator and a stand-in for the radio, not yet on a UV-Pro.
- **Stations near me:** in a radio's **Channels → Add channels…**, the county's RadioReference listings, nearest the
  ZIP code first; open a group and tick its frequencies to add them to the list, each into the first free slot.
  Each says whether the radio can take it (FM, FMN or AM, in its bands; not P25 or other digital modes, nor low band
  or 800 MHz). They're written receive-only with the listing's tone, except a ham repeater, which keeps its input
  and access tone; names are the alpha tags cut to ten characters, numbered if one's taken, and can be edited.
  **Put them on the map** places each at its group's place when written, and the radio can then be switched to that
  region and set scanning (docs/radioreference.md). Tested against the stand-in for RadioReference.
- **Channels as an editable list:** each channel's **Scan** box (unticked, the radio skips it), **Edit** (name,
  frequency, mode, tones, transmit) and **Remove**, with **Undo**; **Add channels…** has **Stations near me** and
  **By hand**, each into the first free slot. Changes are highlighted and counted until **Write to radio** writes
  them all after one backup; **Discard** drops them. A change writes only the fields that changed over the radio's
  own record, so turning scan off changes one bit, and a channel programmed elsewhere to transmit keeps its
  transmit. AirScribe never turns transmit on outside the ham bands (docs/channels.md).
- **Static marked, and channels tagged static or weak:** each transmission now keeps the radio's strongest signal
  reading while it came in and its quieting (how far its loud moments stood above its quiet ones, in dB). One under
  6 dB is marked **static** in the feed, its transcript dimmed (Whisper writes sentences into hiss), and counts as no
  speech whatever a model wrote: **Hide no speech** hides it, a cleanup of no speech deletes it, and Insights leaves
  its words out. Clips saved before are measured from their audio at startup. A radio's **Channels** shows each
  channel's transmissions in the last week, tagged **static** when most were and **weak** when the signal reading
  was low, with the numbers on hover; unticking **Scan** has the radio skip one. A static transmission's tooltip
  says what a feed full of static means: the radio's squelch opening on noise. The thresholds are first guesses,
  to tune against real traffic (docs/channels.md).
- **Packets: APRS and the radios' own location sharing:** the packets a radio's own modem decodes (APRS on the
  frequency it's listening to, 144.390 MHz in the US, and the BSS packets these radios send each other) come to
  AirScribe over Bluetooth, as notifications the way HTCommander gets them or as KISS frames on the same link the way
  APRSdroid and TAK-UV-CORE do, and are kept for a month. **Packets** lists them as they come in,
  by kind and by station; **Map → Stations** puts each station or object at its latest place with its symbol and what
  it last said, moving live. Positions (plain, compressed, Mic-E), weather, objects, messages and status are decoded
  (checked against Ham::APRS::FAP's test packets). A short transmission that was only a packet shows the packet and
  isn't transcribed; voice with a packet after it shows both. Receive only (docs/packets.md); tested against the
  simulator, not yet on a radio.
- **Your callsign, and a radio's beacon:** **Your account → Amateur radio** keeps your callsign, SSID, symbol and
  beacon message, and marks your own stations on the Map. A radio's **Controls → Beacon and location sharing** reads
  what it sends of itself (callsign, symbol, message, APRS or BSS, location every few minutes, position after you
  talk), and **Use my profile** fills it in from yours. Only the fields changed are written, and read back. A radio
  set to share its location is asked for its position, which it needs to send its beacons (docs/packets.md).
- **Uniden scanners, through radiocli:** **Radios → Add a scanner** adds an SDS150 (or SDS100, SDS200), whose
  recordings come in rather than over Bluetooth. radiocli records each transmission from the scanner's headphone
  socket with what the scanner said it was, and `tools/radiocli-upload.mjs` sends each one in
  (`POST /api/radios/:id/recordings`). AirScribe files it under the scanner's channel or talkgroup, measures it for
  static and transcribes it. The feed shows its talkgroup, unit and digital mode, and the search finds them. The
  uploader signs in by account or token, files what it sent away, and keeps what AirScribe refused aside with the
  reason. A recording sent twice is kept once. Tested against recordings made in the tests, not yet with radiocli
  or a scanner (docs/scanners.md).
- **An SDS150 over Bluetooth, no sound card:** with the `bumble` backend, **Scan for radios** finds an SDS150 by the
  name it advertises, and AirScribe connects to it as Uniden's U/AWARE app does: it pairs (no PIN, with the scanner
  in its Pairing menu), asks for its status five times a second, and takes each transmission as the scanner sends
  it, Opus audio with the system, department, channel, frequency and talkgroup. Each is filed under that channel and
  frequency and transcribed. The protocol was worked out from a capture of the app (docs/scanners.md). Tested on a
  real SDS150 through a Bluetooth 4.0 dongle, whose link timing and screen polling AirScribe holds to what that
  dongle can carry. A Bluetooth 5 dongle is asked for 251-byte packets and the 2M PHY, as a phone uses. Bumble loads
  the firmware of a Realtek one, such as the TP-Link UB500, once the files are in place (docs/proxmox.md). On a
  UB500 an SDS150's link ran at 251 bytes and 2M with no audio lost, and on such a link the screen is asked for
  every 200 ms during a transmission too, rather than once a second. When an SDS150 goes silent as encryption
  starts after pairing, as it often did, AirScribe keeps the key both sides made by then, so the next try can
  use it rather than needing Reset Pairings on the scanner.
- **An SDS150's screen, keys and waterfall:** **Screen** on a connected SDS150 shows its screen as it changes, with
  its highlighting and its soft keys named from it; a keypad that holds a key as long as it's held (scroll on the
  screen to turn the knob); and its waterfall, asked for only while it's showing. Keys U/AWARE was seen sending are
  solid; Uniden's other codes are dashed until tried (docs/scanners.md).
- **APRS decoded from the audio too:** AirScribe runs a 1200-baud AFSK modem of its own on everything a radio receives,
  so packets come in even if the radio's own modem doesn't hand them over. Each packet says what decoded it (the
  radio, AirScribe, or both, kept once), and the log lists each one with its source (docs/packets.md).
- **Insights:** a view beside the feed, for the last day, week, month or everything, for one radio or channel:
  a word cloud of what was said (common English words and a model's own annotations such as "(static)" left out;
  unit and call numbers kept), transmissions per hour or day, busy hours by weekday, and each channel's
  transmissions and airtime. A word or a channel opens the feed on it. The header now switches between Feed,
  Insights and Admin.
- **Play new, and a channel filter:** the feed can be filtered to one channel (every channel heard is listed, with
  its frequency), and **Play new** plays each transmission that joins the feed as it arrives, one after another, so
  the filters decide what is heard: one radio, one channel, a search, no chirps. A clip plays once its transmission
  has ended and been saved, not live; playing another clip by hand pauses it, and the queue waits.
- **Cleanup:** **Hide no speech** in the feed leaves out transmissions shown as "(no speech recognised)", such as a
  radio's chirp; it's remembered per browser, and Export follows it. An admin can **Delete** a transmission from its
  row, with its transcripts and audio. **Admin → Storage** shows how much is kept, deletes by age and/or no speech
  after showing what would go, and can keep only the last N days automatically (off until set). A transcription
  queued or running for a deleted clip saves nothing.
- **Transcription on the GPU, confirmed:** the `openvino` engine runs on an Arc A750 from an unprivileged Proxmox
  container, with Ubuntu 24.04's own Intel compute runtime; docs/proxmox.md has the steps as they were run.
- **Template:** new containers have the `en_US.UTF-8` locale, so `pct enter` no longer brings locale warnings to
  every apt command, and the login message says to run `apt update` before the first `apt install`.

### 🐞 Bug fixes
- The Map opens in a light-mode browser that hasn't chosen a base map: it was made with no style at all, and stayed
  on "Loading the map…".
- Switching a radio to another region no longer leaves transmissions filed under the old region's channel names:
  the channel list is read again when the radio reports a different region. The radio link also matches each reply
  to its request, so a command the radio doesn't answer can't put every later answer out by one.
- Bytes on a radio's control link that aren't a reply, such as a KISS frame from its modem, are skipped instead of
  read as a broken reply, which could leave the next few replies unreadable and the radio taken for gone.
- **Signing in has its own page.** The sign-in form no longer sits above radios and transmissions that can't be used
  yet; it covers the page until it's done, asks for a username only when one is set and for an API token where only
  tokens are, and a Sign out button joins the header.
- A radio that stopped answering is reconnected by the server's retry, instead of the retry finding the dead link and
  doing nothing.
- Admin → Updates no longer offers a CI or local build (`0.1.0+ci…`) the release it was built on, which would have
  been a step back; the updater refused it anyway.
- Changing the password with `tools/configure.mjs` as root no longer leaves the settings file unreadable to the
  service.

## 0.1.0
### ✨ Features and improvements
- **Proxmox LXC template and a .deb:** each release carries `AirScribe-v<version>-proxmox-amd64.tar.zst`, Proxmox's
  Ubuntu 24.04 template with Node 24 and AirScribe installed, and `airscribe_<version>-1_all.deb` for Ubuntu 24.04
  and Debian 12. A new container sets its port and a sign-in password at its first boot, from
  `/etc/airscribe/firstboot.env` or made for it and left in `/root/airscribe-first-login.txt`
  (docs/proxmox.md). Releases are built, boot-tested and published by GitLab CI.
- **Admin → Updates:** an admin sees the version running and any newer release with its notes, and can update to
  it from the browser. A root-only updater downloads the release's .deb, checks it against the release's
  `SHA256SUMS`, installs it with the database saved, and puts the old version back if the new one doesn't start
  (docs/updating.md). Installs from the .deb and the Proxmox template only.
- **Transcription on an Intel GPU:** the `openvino` engine runs Whisper and SenseVoice through OpenVINO GenAI on an
  Intel Arc card, and moves to the CPU, saying so in the log, when the GPU won't load the model
  (docs/transcription.md).
- **`whisper-server` engine:** runs whisper.cpp's server, which loads the model once and keeps it, instead of
  whisper-cli for every clip. With whisper.cpp built for Vulkan, it is the second way onto an Intel GPU, through
  Mesa's driver rather than Intel's runtime (docs/transcription.md).
- **`tools/probe-bumble.py`:** reaches a radio through Bumble, a Bluetooth stack in Python that drives a USB dongle
  directly, to find out whether the radio link can work on Windows and in a container without the system's
  Bluetooth.

### 🐞 Bug fixes
- Upgrading a database from before transcripts had their own table no longer drops a finished transcript that
  didn't record which engine made it; it's kept as `unknown`.
