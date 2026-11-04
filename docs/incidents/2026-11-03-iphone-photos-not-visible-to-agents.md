---
failure: iPhone HEIC photos were accepted but could not be previewed or read by the server agent.
date: 2026-11-03
fix_commits: []
cause_status: confirmed
---

# iPhone photos reached custody but not the reader or agent

## What was seen

Tejas reported on November 3 that two photos attached from his iPhone did not appear in
his Kindle message and might not have reached the agent. The retained attachment rows
showed `IMG_7335.HEIC` and `IMG_7336.HEIC`, both `image/heic`, accepted at 11:10 PM ET.
Their camera bytes were valid HEIC files. The server's existing image tools could not
decode them because the HEVC HEIF decoder plugin was absent; a browser without HEIC
support also cannot preview the originals.

## Cause

The attachment owner stored and projected HEIC bytes without a readable derivative. The
server's installed image tools lacked the HEVC HEIF decoder plugin.

## Fix

The repair preserves the camera bytes and prepares a JPEG under the same attachment ID.
The message projection and agent input use that JPEG. Existing photos are prepared when
read, so the two accepted messages do not need reposting or a new human action. The
server decoder and HEVC plugin were installed, and the two retained originals were
decoded to full-resolution JPEGs during diagnosis. Those copies were also given to the
running Kindle agent, which confirmed it had already decoded and read both originals.

## Acceptance scenario

- **Seed:** a session that accepts attachments, with a HEIC image from an iPhone.
- **Action:** upload the image through the normal attachment door and send it to a session.
- **Expected:** a second open page draws the picture, the agent receives JPEG bytes,
  and the original endpoint returns the exact uploaded digest.
- **Replayable offline:** yes (a retained HEIC can be uploaded to an isolated owner).

Additional live check: upload a HEIC through the normal attachment door, read its message on a
second open page, confirm the image appears, confirm the agent receives JPEG bytes,
then read the original endpoint and compare its digest with the retained upload. For
the historical two, read each accepted attachment through the installed owner and
confirm the returned JPEG opens and the original digest is unchanged. A ProRAW DNG
and a paired Live Photo movie need separate real examples before claiming those
formats were observed end to end.
