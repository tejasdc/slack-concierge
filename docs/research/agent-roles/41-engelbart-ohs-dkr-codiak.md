# Engelbart's Later Framework: CoDIAK, DKR, OHS, A/B/C Levels, NICs, Bootstrapping

Research compiled from primary sources at dougengelbart.org (Doug Engelbart Institute),
with exact quotes and citable "purple number" addresses where the source page provides
them (Engelbart's own convention — every paragraph gets a permanent, human-readable
address, which is itself one of the OHS requirements below).

Primary sources actually read (full text, not abstracts):
- Engelbart, "Knowledge-Domain Interoperability and an Open Hyperdocument System" (1990) —
  https://dougengelbart.org/content/view/114/ (AUGMENT,132082,)
- Engelbart, "Toward High-Performance Organizations: A Strategic Role for Groupware" (1992) —
  http://dougengelbart.org/content/view/116/ (AUGMENT,132811,)
- Lehtman, Engelbart & Engelbart, "Technology Template Project: OHS Framework" (1998, v2) —
  https://www.dougengelbart.org/content/view/110/460/ (ALLIANCE,980,)
- Engelbart, "Boosting Our Collective IQ: A Selection of Readings" (1995, excerpts of the
  above three papers plus epilogue) — https://dougengelbart.org/content/view/171/ (AUGMENT,133150,)
- Engelbart, "Improving Our Ability to Improve: A Call for Investment in a New Future"
  (2002/2003 transcript) — https://worrydream.com/refs/Engelbart_2003_-_Improving_Our_Ability_to_Improve.pdf
  (scanned original also at dougengelbart.org/pubs/papers/scanned-original/2002-augment-133320-...)
- Engelbart, "Augmenting Human Intellect: A Conceptual Framework" (1962) — canonical page
  https://dougengelbart.org/content/view/138/ (AUGMENT,3906,); full text read via mirror
  https://www.lri.fr/~mbl/ENS/FundHCI/2018/papers/Englebart-Augmenting62.pdf
- Engelbart, "Bootstrapping Organizations into the 21st Century — A Strategic Framework"
  (1991) — https://dougengelbart.org/pubs/augment-132803-Bootstrapping.html (AUGMENT,132803,)
- About OHS — https://www.dougengelbart.org/ohs ; OHS archive index — https://dougengelbart.org/archives/ohs/

Not independently verified (site returned only summaries/redirects, or was unreachable):
the "Unfinished Revolution II" colloquium transcripts in depth, the exact numbered
OHS "requirements pages" at content/view/110 and /111 as a standalone numbered list distinct
from the Technology Template Project (110/460 appears to be the correct current path for that
same document), and abccommunity.org (TLS cert mismatch, could not fetch).

---

## 1. The concepts, plainly, with examples

### H-LAM/T and the Capability Infrastructure

Engelbart's foundational unit, from "Augmenting Human Intellect: A Conceptual Framework"
(1962), is not "the human" or "the computer" but the whole coupled system:

> "We assume that it is our H-LAM/T system (Human using Language, Artifacts, Methodology,
> in which he is Trained) that has the capability and that performs the process in any
> instance of use of this repertoire." (§2a13-14)

H = the human; L = Language (the concepts and vocabulary the human thinks in); A = Artifacts
(pencils, filing cabinets, computers, displays); M = Methodology (procedures, conventions,
strategies); T = Training (how the human learned to use all of the above together). Engelbart
insists these five co-evolve as one unit — improve the artifact alone (give someone a better
tool) without upgrading language, method and training, and the system's capability barely
moves. He later relabels this the **Capability Infrastructure**, split into two cooperating
sub-systems (1992 paper, Figure 1, and reprised in the 2002 talk, Figure 4):

> "Figure 1 shows a Capability Infrastructure made up of Human System elements — such as
> peoples' paradigms, organization, procedures, customs, methods, language, attitudes,
> skills, knowledge and training — as well as Tool System elements — such as media,
> portrayal, viewing, study, retrieval, manipulation, computing, communications."
> (1992, §2 figure caption)

**Concrete example (Engelbart's own):** writing a memo. If it's a short memo, planning,
drafting and composing may happen entirely "in the head" (explicit-human process). If it's
long and complex, the same sub-processes become "composite" — mixed human+artifact (pencil
and paper, or a word processor) — and the *executive* capability (deciding what to do next,
in what order) is what "embodies the methodology" (§2a17). The system that writes the memo is
the whole H-LAM/T stack, not the pen or the person alone.

**Augmentation vs. automation** (explicit distinction, 2002 talk, "The Human-Augmentation
System Interface," Figure 4):

> "These dynamic elements are the 'magic dust' that makes the whole system capable of
> innovation and of solving complex problems. These are what make an 'augmentation system'
> different than a mere automation system... If this interface is low bandwidth and able to
> pass only a small amount of what the human knows and can do — and what the machine can
> portray — then the entire system tends to be more 'automation' than 'augmentation', since
> the computer and the human are being kept apart by this low-fidelity, limited interface."

I.e., automation replaces the human at a task; augmentation widens the bandwidth of exchange
between human and tool so the human's own capability is amplified. Engelbart's whole framework
is explicitly on the augmentation side of that line.

### CoDIAK — Concurrent Development, Integration and Application of Knowledge

Engelbart's name for the organizational knowledge process he considers the single highest-
leverage target for improvement. From the 1992 paper:

> "In my mind, the point of greatest leverage is what I have come to call 'CoDIAK' for the
> COncurrent Development, Integration and Application of Knowledge." (§6, "The CODIAK
> Process Cluster")

He derives it from three concurrent knowledge streams that any working group maintains
(Figure 7 in the 1992 paper; also Figure 3 in the 2002 talk):

1. **Intelligence Collection** — "An alert project group ... keeps a watchful eye on its
   external environment, actively surveying, ingesting, and interacting with it. The
   resulting intelligence is integrated with other project knowledge on an ongoing basis to
   identify problems, needs, and opportunities which might require attention or action."
   (1992, §6g1)
2. **Dialog Records** — "Responding effectively to needs and opportunities involves a high
   degree of coordination and dialog within and across project groups. This dialog, along
   with resulting decisions, is integrated with other project knowledge on a continuing
   basis." (§6g2)
3. **Knowledge Product** — "The resulting plans provide a comprehensive picture of the
   project at hand, including proposals, specifications, descriptions, work breakdown
   structures, milestones, time lines, staffing, facility requirements, budgets, and so on...
   The CODIAK process is rarely a one-shot effort. Lessons learned, as well as intelligence
   and dialog, must be constantly analyzed, digested, and integrated into the knowledge
   products throughout the life cycle of the project." (§6g3)

**Concrete example:** a project team watches trade press and competitor moves (intelligence),
argues out design decisions in meetings and email (dialog), and produces specs/plans/status
reports that get revised as the argument and the outside world move (knowledge product). None
of these three streams is separate software; CoDIAK is the claim that they must be captured,
cross-linked and *continuously re-integrated* rather than siloed — "the CODIAK process is rarely
a one-shot effort."

In the 2002 talk Engelbart gives the mnemonic explicitly: "Concurrent Development /
Integration across the different concurrent activities though continuous dialog ... /
Application of the knowledge that is gained ... you can take 'Concurrent Development,'
'Integration,' and 'Application of Knowledge' and put them together in the term 'CoDIAK.'"

### DKR — Dynamic Knowledge Repository

The place where the three CoDIAK streams live and stay integrated. Engelbart's clearest
one-paragraph definition, from the 2002 talk:

> "One of the most important things that we need is a place to keep and share the
> information that we collect — the dialog, the external information, the things that we
> learn. I call this the 'Dynamic Knowledge Repository,' or DKR. It is more than a database,
> and more than a simple collection of Internet web sites. It doesn't have to be all in one
> place — it can certainly be distributed across the different people and organizations that
> are collaborating on improving improvement — but it does need to be accessible to
> everyone — for reading, for writing, and for making new connections." (p.10)

**Concrete example:** for a C-level improvement community (see A/B/C below), the DKR is not
a single database table but the union of its recorded dialog (meeting notes, email threads),
its intelligence feed (what it's learned from outside), and its living "handbook" of what it
currently knows how to do — accessible, addressable, and cross-linked, whether that content
sits in one server or is federated across member organizations. Engelbart pairs the DKR with
a "hyperscope" — his term for a tool that lets "everyone... contribute and use the information
in the DKR according to his or her ability," so a beginner and a high-performance user share
the same underlying knowledge base through different views.

### OHS — Open Hyperdocument System

The *technology* (not the knowledge base itself) that Engelbart argues a DKR/CoDIAK needs
underneath it — the "hierarchy of characteristics ... by which commercial and research tools
can be designed, implemented, and evaluated" (1998 Technology Template, §1a). Two words:

> "'Hyperdocument' implies flexible linkages to any object in any multi-media file. 'Open'
> implies vendor-independent access to the hyperdocuments within and across work groups,
> platforms, and applications." (1998, §1a)

The 1995 "Boosting Our Collective IQ" epilogue frames it as the still-missing piece even after
the Web arrived: "The architecture of the future electronic documents, and of the supportive
application systems for working with them, will be a critical factor... the critical
yet-to-emerge technology for pursuing these goals is the Open Hyperdocument System (OHS)."
The full numbered requirements are in §2 below.

### A/B/C Activity Levels

From the 1992 paper (§3-4) and restated in the 2002 talk. Three nested levels of
organizational activity:

> "**A** [activity] representing the core business activity (i.e. product R&D, manufacturing,
> marketing, sales, operations...), supported by activity **B** representing the activity of
> improving A. B should be a permanent continuous improvement activity." (1992, Figure 3
> caption)
>
> "[C is] the organization's C Activity. Executive efforts to assess and improve B-Activity
> funding, staffing, and high-level approach would qualify as a C Activity. C Activities
> would also include introducing new knowledge and skills into the B Activity, providing
> better means for participatory interaction with its A-Activity clients, or improving how
> pilot operations are managed." (1992, §4c)
>
> "B [activity is characterized] as improving product-cycle time and quality, and C as
> improving improvement-cycle time and quality." (1992, Figure 4 caption)

The investment-leverage argument (1992, §5c): "An investment that boosts the A Capability
provides a one-shot boost. An investment that boosts the B Capability boosts the subsequent
rate by which the A Capability increases. And an investment that boosts the C Capability
boosts the rate at which the rate of improvement can increase" — i.e., A/B/C map onto the
value, its first derivative, and its second derivative. This is where "bootstrapping" gets its
name for Engelbart ("This was where the term bootstrapping became welded into my continuing
professional framework," §5f).

**Concrete example:** a car company (A) builds cars; a continuous-improvement group inside it
(B) works on how cars get designed/built faster and better; a small cross-company group (C)
works on how *improvement itself* gets done better — shared methods for running pilots,
shared tooling for the improvement teams, shared vocabulary — because a gain there compounds
into every B activity that adopts it, in every member company.

### NIC — Networked Improvement Community

Engelbart's 1992 term for this is **"C Community"**: multiple organizations' C-activities
joining forces (Figure 12, §11e), because C-level work is largely pre-competitive:

> "About proprietary matters: The A Activity of each organization may be very competitive...
> The B Activity of each would tend to be less so... The C Activity of each would be much
> less involved in proprietary issues, and much more in basic, generic matters. So even
> competitors could consider cooperating, 'out of their back doors' — 'while competing like
> hell out of our front doors.'" (1992, §11g)
>
> "The output of the C Community boosts the B activities within the member organizations, and
> also feeds back to boost the C activities [itself]." (Figure 12 caption)

By 1995 the term "networked improvement communities" appears explicitly in the "Boosting Our
Collective IQ" epilogue, listed among the domains that would benefit from OHS-supported
CoDIAK: "...networked improvement communities, re-engineering, tele-commuting, digital
libraries, distance learning, crisis action, and so on." The Carnegie Foundation for the
Advancement of Teaching later adopted "Networked Improvement Community (NIC)" as a named
methodology explicitly crediting this 1992 origin (secondary source, not dougengelbart.org).
In the 2003 talk Engelbart describes his own organization the same way, without the acronym:
"the Bootstrap Alliance is an improvement community that is made up of other improvement
communities — we are focused on improving the ability to improve, and on helping other groups
that share those interests do a better job of it. We exist to help C-level organizations do a
better job of being C-level organizations."

**Concrete example:** several aerospace primes, each running their own internal improvement
group (B), pool a few people and a shared prototype OHS into one cross-company "C Community"
(NIC) whose job is to work out shared knowledge-work practices and push the results back down
into each member's B activity — cheaper for all of them than each running its own advanced
pilot from scratch (1992, §11m: "it would be much more expensive for each member organization
to provide equivalent experience by operating its own advanced pilot").

### Bootstrapping

Not "self-sufficiency" in the everyday sense — Engelbart means the specific compounding
mechanism where the tool/process being built is *also used to build itself*, so gains at the
C level feed back into the C level's own capability as well as flowing down to B and A. His
own analogy (2002 talk, p.9-10):

> "It is a very American term — the image is of someone able to perform the wonderful,
> impossible trick of pulling himself up by pulling up on his own bootstraps — but the idea is
> one that we put into practice every time that we 'boot up' a computer. A small bit of code
> in a permanent read only memory knows how to go out to the disk to get more instructions,
> that in turn know how do to even more things... Eventually, this process of using successive
> steps to lead to ever bigger steps, building on each other, get the whole machine up and
> running."

Applied to CoDIAK/DKR: "This is precisely the kind of outcome that can come from investment
in building a DKR at the C level. What you learn there can be used to improve work at the C
level, which in turn improves ability at the B level, which then translates into new
capability at the primary, A level of the organization." Note the recursion is deliberate, not
incidental: "pursuit of CODIAK requires, in itself, some technical infrastructure to support
the concurrent development and continual integration of dialog... If this sounds somewhat
recursive to you, like the snake renewing itself by swallowing its own tail, be assured that
the recursion is not an accident."

---

## 2. OHS requirements — exact numbered list

Engelbart published this list twice in materially the same form, five years apart. The
**1990** version ("Knowledge-Domain Interoperability and an Open Hyperdocument System," §11,
"Essential Elements of an OHS") is the original 11-item list plus 3 more "general integrated
architecture" items in §12. The **1998** "Technology Template Project: OHS Framework"
reorganizes the same content into an explicit hierarchy (with an added "Journal System" as a
first-class item and clearer separation of Access Control from Portrayal). Both are quoted
below with their exact wording and their citable "purple number" paragraph address on the
source page (Engelbart's own scheme — this addressability is itself requirement #10 below).

### A. From the 1990 paper (source: https://dougengelbart.org/content/view/114/, §11-12)

1. **Mixed-Object Documents** [§11a] — "to provide for an arbitrary mix of text, diagrams,
   equations, tables, raster-scan images (single frames, or even live video), spread sheets,
   recorded sound, etc — all bundled within a common 'envelope' to be stored, transmitted,
   read (played) and printed as a coherent entity called a 'document.'"
2. **Explicitly Structured Documents** [§11b] — "where the objects comprising a document are
   arranged in an explicit hierarchical structure, and compound-object substructures may be
   explicitly addressed for access or manipulation of the structural relationships."
3. **View Control of Objects' Form, Sequence and Content** [§11c] — "where a structured,
   mixed-object document may be displayed in a window according to a flexible choice of
   viewing options — especially by selective level clipping (outline for viewing), but also
   by filtering on content, by truncation or some algorithmic view that provides a more
   useful view of structure and/or object content (including new sequences or groupings of
   objects that actually reside in other documents). Editing on structure or object content
   from such special views would be allowed whenever appropriate."
4. **The Basic "Hyperdocument"** [§11d] — "where embedded objects called 'links' can point to
   any arbitrary object within the document, or within another document in a specified
   domain of documents — and the link can be actuated by a user or an automatic process to
   'go see what is at the other end,' or 'bring the other-end object to this location,' or
   'execute the process identified at the other end.' (These executable processes may control
   peripheral devices such as CD ROM, video-disk players, etc.)"
5. **Hyperdocument "Back-Link" Capability** [§11e] — "when reading a hyperdocument online, a
   worker can utilize information about links from other objects within this or other
   hyperdocuments that point to this hyperdocument — or to designated objects or passages of
   interest in this hyperdocument."
6. **The Hyperdocuments "Library System"** [§11f] — "where hyperdocuments can be submitted to
   a library-like service that catalogs them and guarantees access when referenced by its
   catalog number, or 'jumped to' with an appropriate link. Links within newly submitted
   hyperdocuments can cite any passages within any of the prior documents, and the back-link
   service lets the online reader of a document detect and 'go examine' any passage of a
   subsequent document that has a link citing that passage."
7. **Hyperdocument Mail** [§11g] — "where an integrated, general-purpose mail service enables
   a hyperdocument of any size to be mailed. Any embedded links are also faithfully
   transmitted — and any recipient can then follow those links to their designated targets in
   other mail items, in common-access files, or in 'library' items."
8. **Personal Signature Encryption** [§11h] — "where a user can affix his personal signature
   to a document, or a specified segment within the document, using a private signature key.
   Users can verify that the signature is authentic and that no bit of the signed document or
   document segment has been altered since it was signed."
9. **Access Control** [§11i] — "Hyperdocuments in personal, group, and library files can have
   access restrictions down to the object level."
10. **Link Addresses That Are Readable and Interpretable By Humans** [§11j] — "one of the
    'viewing options' for displaying/printing a link object should provide a human-readable
    description of the 'address path' leading to the cited object; AND, that the human must
    be able to read the path description, interpret it, and follow it (find the destination
    'by hand' so to speak)."
11. **Every Object Addressable** [§11k] — "in principle, every object that someone might
    validly want/need to cite should have an unambiguous address (capable of being portrayed
    in a manner as to be human readable and interpretable). (E.g., not acceptable to be unable
    to link to an object within a 'frame' or 'card.')"
12. **Hard-Copy Print Options to Show Addresses of Objects and Address Specification of
    Links** [§11l] — "so that, besides online workers being able to follow a link-citation
    path (manually, or via an automatic link jump), people working with associated hard copy
    can read and interpret the link-citation, and follow the indicated path to the cited
    object in the designated hard-copy document." Plus [§11l1]: a hard-copy worker should be
    able to "determine a valid address path to [an] object and for instance hand-write an
    appropriate link specification for later online entry, or dictate it over a phone to a
    colleague."

Three more, filed under "Hyperdocuments in a General Integrated Architecture" [§12]:

13. **Shared-Window Teleconferencing** [§12b] — "where remote distributed workers can each
    execute a related support service that provides the 'viewing' workers with a complete
    dynamic image of the 'showing' worker's window(s)... Control of the application program
    (residing in the 'showing' worker's environment) can be passed around freely among the
    participants."
14. **Inter-Linkage Between Hyperdocuments and Other Data Systems** [§12c] — "for instance, a
    CAD system's data base can have links from annotations/comments associated with a design
    object that point to relevant specifications, requirements, arguments, etc. of relevance
    in a hyperdocument data base — and the back-link service would show hyperdocument readers
    which passages were cited from the CAD data base."
15. **External-Document Control (XDOC)** [§12d] — "Same 'catalog system' as for hyperdocument
    libraries — with back-link service to indicate links from hyperdocument (and other) data
    bases, for any relevant material that resides offline or otherwise external to the OHS."

### B. From the 1998 "Technology Template Project: OHS Framework" (same content, reorganized;
source: https://www.dougengelbart.org/content/view/110/460/)

The 1998 version nests the same elements under four headings and makes the **Journal**
explicit as its own item (it was folded into "Library System" in 1990):

- **Hyperdocument Content and Structure** [§2a]: Elementary Objects [§2a1a]; Mixed-Object
  Documents [§2a1b]; Shared Objects [§2a1c]; Object ID-Time Stamps [§2a1d] — "Each creation or
  modification of an object automatically results in the creation of a stamp containing
  information concerning the date, time... and user identification"; Personal Signature
  Encryption [§2a1e]; Explicitly Structured Documents [§2a2a]; Shared Documents [§2a2b] —
  "This is the most fundamental requirement of an OHS."
- **Access and Portrayal** [§2b]: Global, Human-Understandable, Object Addresses [§2b1a];
  Link Addresses Readable/Interpretable by Humans [§2b1b]; The Basic "Hyper" Characteristics
  [§2b2a] (links, incl. actuation "by a user or an automatic process," same wording as 1990);
  Hyperdocument "Back-Links" [§2b2b]; Access Control [§2b2c] — now explicit that it is "based
  on individual identity or organizational role"; View Control of Objects' Form, Sequence and
  Content [§2b3a]; Hard-Copy Print Options [§2b3b]; Hyperdocument Mail [§2b4a]; **The
  Hyperdocument "Journal System"** [§2b4b] — "A Journal is an integrated library-like system
  into which a hyperdocument message or document can be submitted. An automated 'clerk'
  assigns each Journal document a unique, permanent catalog number, stores the item, notifies
  designated recipients... with a link for easy retrieval, notifies of supercessions, catalogs
  it for future searching, and manages document collections. Access to Journal documents is
  guaranteed... Links within newly submitted hyperdocuments can cite any passages within
  prior documents." It adds: "Thus citations to Journal items will always be valid while
  citations to Throw-Away Email are not guaranteed" [§2b4c2] — i.e., the Journal is the
  **recorded and immutable** tier, distinct from disposable mail; External Document Control
  (XDoc) [§2b4c].
- **Services, Applications and Utilities** [§2c]: Global and Individual Vocabulary Control
  [§2c1a] (a "Command Meta Language" / "Command Language Interpreter" abstraction so a common
  "workshop vocabulary" survives across differing look-and-feel front ends); Multiplicity of
  Look-and-Feel Interface Choices [§2c1b]; Shared-Window Teleconferencing [§2c2a]; Real-time
  communication [§2c2b]; Inter-Linkage to Other Data Systems (e.g. CAD) [§2c3a]; End User
  Programmability / Extensible applications [§2c4a].
- **End User Systems** [§2d]: a "Foundational Knowledge Environment" aimed at "supporting the
  ongoing development of work-in-progress for individuals, teams, organizations, communities,
  whole nations... integrating dialog records, intelligence collections, as well as knowledge
  products" [§2d1a] — i.e., this whole hierarchy exists to carry CoDIAK/DKR. Its "Paradigm
  Shift Summary" table [§2d1e] is a compact statement of the whole philosophy, e.g. "Tool-
  centric system → Document-centric system"; "File level addressability → Object-level
  addressability"; "'Load & scroll browsing'... → 'Precision browsing': Jumping directly to
  any object in any file with on-the-fly custom views"; "Isolated passive libraries and
  archives → Active 'living' libraries seamlessly integrated within the organization's work
  processes."

The 1998 document explicitly states its lineage: "The above requirements are an extension of
Engelbart's 1992 Groupware paper... refer to sections 1-5 for rationale" [Ref-1], and both
documents trace back to "the original motivation for this work," citing the 1962 "Augmenting
Human Intellect" report directly [Ref-3].

**About OHS** (https://www.dougengelbart.org/ohs) restates the top two priorities more
tersely for a modern reader: "(1) Jump or link directly to any point in any file. (2) Change
your view of a file to suit immediate needs" — i.e., precision addressing and view control are
the two the whole system is really organized around.

---

## 3. Agents and automation inside the OHS/DKR

Engelbart's OHS papers predate the "AI agent" vocabulary, but automation is explicitly
designed into the link/object model, always as an *option alongside* human action rather
than a replacement for it — consistent with the augmentation/automation distinction in §1:

- **Links can be actuated by a program, not just a person** — the core "Basic Hyperdocument"
  requirement itself: "the link can be actuated by **a user or an automatic process** to 'go
  see what is at the other end,' or 'bring the other-end object to this location,' or
  '**execute the process identified at the other end**.' (These executable processes may
  control peripheral devices such as CD ROM, video-disk players, etc.)" (1990, §11d; verbatim
  repeated in 1992 §3b and 1998 §2b2a1). This is the closest Engelbart gets to a general
  "agent" primitive: a link's destination can itself *be* an executable process, triggered
  either by a human clicking it or by some other automatic process — object addresses double
  as callable targets.
- **An automated "clerk" runs the Journal** — not a person: "An automated 'clerk' assigns each
  Journal document a unique, permanent catalog number, stores the item, notifies designated
  recipients (if any) with a link for easy retrieval, notifies of supercessions, catalogs it
  for future searching, and manages document collections." (1998, §2b4b2; same wording 1990
  §11f/1992). The clerk is explicitly automated infrastructure performing what would otherwise
  be manual librarian work — intake, cataloging, notification, versioning.
- **"Smart retrieval tools"** doing autonomous search over the knowledge base: "Everyone is but
  one quick 'link hop' away from any piece of knowledge representation anywhere in the whole
  knowledge collection. **Smart retrieval tools can rapidly comb part or all of the collection
  to provide lists of 'hit links' with rated relevance probabilities.**" (1995 "Boosting Our
  Collective IQ," §3d, "Knowledge Product" scenario) — an explicit description of something
  like a ranked-search agent operating over the DKR.
- **User-shareable automation/macros over the intelligence stream**: "I can share with you a
  macro I wrote to trap certain incoming intelligence items and reformat them in a certain
  way, and you could fire this up in your own environment to work off your pet key-words
  (taking advantage of the common-vocabulary architectural feature)." (1995, §3d, "Intelligence
  Collection" scenario) — end-user-authored filtering/automation, portable because of the
  shared Command-Language-Interpreter vocabulary (§2 above), i.e. automation is *composable*
  across users because the verb/noun vocabulary is standardized system-wide, not per-app.
- **Speech-processing tools acting on the Dialog stream**: "tools will soon become generally
  available for flexibly contributing, integrating, and interlinking digitized speech into the
  OHS knowledge base. Early tools would be available for speaker recognition, for
  special-word recognition, and even for basic transcription to text — and for installing and
  following links between modules as small as a word embedded in a long speech string." (1995,
  §3d, "Dialog Records" scenario) — automated capture/processing feeding directly into the
  Journal, decades ahead of the underlying tech.
- **The Command Language Interpreter (CLI) as an execution layer separate from any human
  interface**: "A Command Language Interpreter (CLI) interprets user actions, based upon the
  contents of the currently attached grammar file, and executes appropriate actions via remote
  procedure calls to a common application program interface of the 'open system environment.'"
  (1998, §2c1a3) — this is infrastructure-level automation (a uniform action-execution layer
  under many different front ends), not a "user," and it is what lets look-and-feel vary while
  the underlying verb/noun vocabulary — and therefore any automation written against it —
  stays constant (§2c1b3-5).
- **Explicit framework-level caution against over-automating**: the augmentation/automation
  distinction in the 2002 talk (quoted in §1) is Engelbart's own guardrail: a system where the
  "H-AS Interface" (human–augmentation-system interface) is high-bandwidth stays an
  *augmentation* system; one where it's low-bandwidth — machine acting on the human's behalf
  without rich exchange — "tends to be more 'automation' than 'augmentation.'" He frames this
  as a design choice about *interface bandwidth*, not a rejection of automation as such: the
  Journal clerk, smart retrieval, and automatic link actuation above are all automation he
  explicitly wants, precisely because they sit inside a system whose overall bandwidth to the
  human stays high (structure, addressability, view control, back-links) rather than replacing
  that bandwidth.

No document read used the words "agent" or "intelligent agent" as a named architectural
component — Engelbart's unit of design is the *link/object* (which may resolve to an
executable process) and the *tool/service* (Journal clerk, CLI, retrieval), not a persistent
autonomous actor. The closest analogue to a modern "agent" is the automatically-actuated link
target in requirement #4 above, generalized by the Journal's automated clerk and by "smart
retrieval tools" operating over the DKR.
