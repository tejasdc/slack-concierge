# Capture presentation

The Inbox retains each capture as one input row with its source, text and attachment
custody IDs. The capture space asks the native owner for a page of twenty such inputs
in descending input order. The cursor is the last row position. This read neither
opens provider conversation history nor attachment bytes. Each list item carries a
4 KiB text preview; the exact capture read remains the source for full text and
attachment metadata.

The exact capture read selects attachment name, content type and hash from the
custody table. It does not open or encode the bytes. The existing attachment route
provides bytes when the browser requests a chosen picture or recording. This boundary
matters for screen recordings because one capture can have many frames.

The partial capture index keeps accepted-input order inside each session without
sorting unrelated conversation traffic. The presentation reader contract limits one
page to twenty items, twenty-one input rows and 256 KiB of response data. Its growth check exercises the indexed page over
ten thousand retained inputs. The browser can page older captures, while an exact
capture identity remains independently addressable.
