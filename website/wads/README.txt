Put your IWAD files here: doom.wad / DOOM.WAD, doom1.wad, freedoom1.wad, freedoom2.wad, heretic.wad, tnt.wad, plutonia.wad.

doomApi.launch({wadId: "doom"}) loads /wads/freedoom1.wad first, then the remote mirrors.
Any custom name works too: copy DOOM.WAD here, then launch({wadId: "duom"}) tries /wads/duom.wad and /wads/DUOM.WAD (case-insensitive names on Windows servers).

Local disk paths (file:///C:/..., C:\...) cannot be read by a browser directly.
launch({wadUrl: "file:///C:/users/daf/downloads/base/DOOM.WAD"}) is now remapped automatically onto:
  /wads/DOOM.WAD  +  http://127.0.0.1:8090|8000|8080/DOOM.WAD
So either copy the .wad into this folder, or run inside its folder:
  python -m http.server 8090 --bind 127.0.0.1
or use the native file dialog once: await doomApi.pickAndLaunch({levelCode: "E1M1"}).
