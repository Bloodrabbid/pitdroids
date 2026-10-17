# Pit Droids — fan port (web)

An unofficial, non-commercial fan port of a 1999 puzzle game, running in the browser:
https://bloodrabbid.github.io/pitdroids/

This repository holds only the built engine. **No files of the original game are included** —
graphics, sound, movies, puzzles and texts belong to their owners. On the first visit you point the page
at **your own copy of the game** — the installed folder or the CD, a disc image (.iso / .bin), a .zip, or
the iPhone/iPad app (.ipa); several copies can be combined (e.g. English and a Russian translation). The
page converts it to the game's files right in the browser — nothing is uploaded anywhere — keeps them
there, and the game then works offline (installable as an app). A data pack made from your copy works too.

## Third-party code
The Sorenson Video 1 movie decoder is a TypeScript port of FFmpeg's `libavcodec/svq1dec.c` and its tables
and is licensed under the GNU Lesser General Public License 2.1 or later. Its source is in
[`source/svq1/`](source/svq1/) (with the license text); the rest of the engine is a separate work.

Not affiliated with or endorsed by Lucasfilm or Disney.
