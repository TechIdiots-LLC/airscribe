# Finding where a channel is: RadioReference

The Map's **Find** looks a channel's frequency up in the
[RadioReference.com](https://www.radioreference.com) database and offers the
places it might be, best first; **Place here** puts the channel there. It's an
admin's, as placing a channel by hand is.

## What it needs

- **A RadioReference account with a Premium subscription.** The lookup signs in
  as that account, as RadioReference's terms require of every user of its API.
- **An app key for AirScribe.** RadioReference issues these to an application's
  developer, free, after reviewing an application at
  <https://www.radioreference.com/account/api/apply> (signed in, with Premium).
  A tool run alongside a scanner is the use the API is for; RadioReference won't
  issue a key to anything that mirrors or substitutes for its website.
- **A US ZIP code**, whose county is searched first. RadioReference's ZIP lookup
  is US only.

## Setting it up

In **Admin → RadioReference**, enter the username, password, app key and ZIP
code and press **Save**; AirScribe signs in straight away and says until when
the account is Premium, and which town the ZIP code is. **Test** does that again
later. The password and key are kept in AirScribe's database (as Admin's other
settings are), sent only to RadioReference over HTTPS, and never shown on the
page again: left blank on the form, they stay as saved. **Forget these** clears
all four.

An app key can also go in the settings file, as `radioreference.appKey`; one
entered in Admin is used instead of it.

## What Find does

1. The channel's frequency (as the radio reported it when a transmission came
   in on it) is searched in the ZIP code's county. If the county has nothing on
   it, the whole state is.
2. Of the listings found, those whose names are most like the channel's come
   first. A radio's ten-letter name is read as a listing spells it out: `PD` is
   police, `FD` fire, and `Rutld` Rutland.
3. For each listing with an FCC callsign, the licence's sites are looked up,
   and the ones that transmit on that frequency are offered, with their address:
   usually exactly where the transmitter is. A licence that doesn't say which of
   its sites sends the frequency has its fixed sites offered, saying so.
4. Each listing's area is offered too: the place and range RadioReference gives
   the agency or town, or the middle of the county where it gives none.

The places are numbered alike in the list and on the map. Only conventional
listings are used: a trunked system's frequencies aren't a channel's.

Answers are kept for six hours, so looking up several channels in one county
asks for the county once. Saving the settings starts afresh.

## Stations near me: writing listings to a radio

A radio's **Channels** dialog (docs/channels.md) has **Stations near me** once
RadioReference is set up. It lists the county's groups (a town's fire
department, say), nearest the ZIP code first, with those RadioReference gives
no place of their own (county-wide) last. Opening a group asks for its
frequencies (`getSubcatFreqs`); a mode given as a number is named with
`getMode`. Each frequency says whether the radio can take it:

- **FM, FMN and AM** can be written; FMN is written narrow, FM wide. P25, DMR,
  NXDN and the other digital modes can't: the radio plays FM and AM only.
- **In the radio's bands:** 136–174 and 400–520 MHz, and the airband in AM.
  Low band, 220 MHz and 700/800 MHz listings can't be written.
- **Receive-only:** each is written with transmit off and the listing's tone
  to open the squelch (CTCSS or DCS; a tone the radio has no use for, such as a
  P25 NAC, is left off and said so). A **ham repeater** in the 2 m or 70 cm
  band keeps its input frequency and its tone to transmit with, and no tone
  to receive, since the tone listed is the one it's accessed with.
- **The name** is the listing's alpha tag cut to the radio's ten characters,
  and can be changed before writing. Two picked with the same name get a
  number at the end: the feed and the Map know a channel by its name.

The picked stations are written in order into the region on show, from the
first slot where they all fit into empty slots (or a slot chosen by hand);
what would be replaced is shown first. The region is backed up before it's
written, and each channel is read back from the radio. **Put them on the map**
places each at its group's place, under the name the radio kept, unless that
name has a place already; it shows once a transmission comes in on it.
Afterwards, **Switch the radio to this region and scan** does that.

The county's groups and each group's frequencies are kept six hours, as Find's
answers are.

## Trying it without an account

`test/fixtures/radioreference-fake.js` is a stand-in for the API, answering as
the real one does, with made-up listings around Holden, Massachusetts (ZIP code
01520; username `tester`, password `pa<ss>&word`, app key `TESTKEY`):

```sh
node test/fixtures/radioreference-fake.js 8101
```

Then point AirScribe at it in the settings file:

```json
"radioreference": { "endpoint": "http://127.0.0.1:8101/soap2/index.php" }
```

Its frequencies are 460.3875, 154.31, 154.25 and 146.97 MHz in the county, and
155.175 MHz statewide. For **Stations near me** it has groups in Holden,
Paxton and Rutland, an airport tower and a ham repeater, with a P25 and a low
band listing that can't be written, and modes given as numbers.
