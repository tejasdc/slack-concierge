# Primary sources: Bush (1945), Licklider (1960), Engelbart (1962)

Research method: fetched primary-source HTML directly (via `curl` + tag-stripping, since
the WebFetch tool's summarizer was truncating/paraphrasing long documents), then grepped
for exact passages. All quotes below are verbatim from the fetched text, with section
labels and permanent URLs.

---

## 1. Vannevar Bush, "As We May Think" (The Atlantic, July 1945)

Source URL (live, blocked by direct fetch tool but reachable): https://www.theatlantic.com/magazine/archive/1945/07/as-we-may-think/303881/
Source URL (Wayback Machine mirror actually fetched): http://web.archive.org/web/2020/https://www.theatlantic.com/magazine/archive/1945/07/as-we-may-think/303881/

### 1.1 The mind operates "by association," not by rigid indexing

> "Our ineptitude in getting at the record is largely caused by the artificiality of
> systems of indexing. When data of any sort are placed in storage, they are filed
> alphabetically or numerically, and information is found (when it is) by tracing it
> down from subclass to subclass. It can be in only one place, unless duplicates are
> used; one has to have rules as to which path will locate it, and the rules are
> cumbersome. Having found one item, moreover, one has to emerge from the system and
> re-enter on a new path. **The human mind does not work that way. It operates by
> association.** With one item in its grasp, it snaps instantly to the next that is
> suggested by the association of thoughts, in accordance with some intricate web of
> trails carried by the cells of the brain."

Immediately following, Bush draws the design conclusion:

> "Man cannot hope fully to duplicate this mental process artificially, but he certainly
> ought to be able to learn from it... The first idea, however, to be drawn from the
> analogy concerns selection. **Selection by association, rather than indexing, may yet
> be mechanized.** One cannot hope thus to equal the speed and flexibility with which the
> mind follows an associative trail, but it should be possible to beat the mind decisively
> in regard to the permanence and clarity of the items resurrected from storage."

### 1.2 The memex — definition

> "Consider a future device for individual use, which is a sort of mechanized private file
> and library. It needs a name, and, to coin one at random, 'memex' will do. **A memex is
> a device in which an individual stores all his books, records, and communications, and
> which is mechanized so that it may be consulted with exceeding speed and flexibility. It
> is an enlarged intimate supplement to his memory.** It consists of a desk, and while it
> can presumably be operated from a distance, it is primarily the piece of furniture at
> which he works. On the top are slanting translucent screens, on which material can be
> projected for convenient reading. There is a keyboard, and sets of buttons and levers...
> In one end is the stored material. The matter of bulk is well taken care of by improved
> microfilm."

### 1.3 Associative indexing and "trails" — the mechanism that replaces hierarchy

> "It affords an immediate step, however, to **associative indexing, the basic idea of
> which is a provision whereby any item may be caused at will to select immediately and
> automatically another. This is the essential feature of the memex.** The process of
> tying two items together is the important thing. When the user is building a trail, he
> names it, inserts the name in his code book, and taps it out on his keyboard. Before him
> are the two items to be joined, projected onto adjacent viewing positions... the items
> are permanently joined... Thereafter, at any time, when one of these items is in view,
> the other can be instantly recalled merely by tapping a button below the corresponding
> code space. Moreover, when numerous items have been thus joined together to form a
> trail, they can be reviewed in turn, rapidly or slowly... It is exactly as though the
> physical items had been gathered together from widely separated sources and bound
> together to form a new book. It is more than this, for any item can be joined into
> numerous trails."

Bush then illustrates with the worked example of a user researching why the Turkish bow
outperformed the English longbow in the Crusades, building a trail across an encyclopedia
article, textbooks on physics, and material on mechanics and archery, annotating and
extending it as he goes — the direct ancestor of what became "hypertext" (Ted Nelson later
coined that term explicitly citing Bush).

**Relevance to the report's theme:** Bush's move is the founding move of the whole
lineage — rejecting hierarchical/alphabetical classification as unnatural to how thought
actually proceeds, and proposing a machine whose organizing principle is association
(links) rather than taxonomy. This is the direct ancestor of Engelbart's "symbol
structuring" argument and of every wiki/hypertext/PKM tool that followed.

---

## 2. J.C.R. Licklider, "Man-Computer Symbiosis" (IRE Transactions on Human Factors in
Electronics, vol. HFE-1, pages 4-11, March 1960)

Source URL fetched: http://groups.csail.mit.edu/medg/people/psz/Licklider.html
(widely mirrored; this is the standard full-text mirror)

### 2.1 The Summary (opening abstract) — division of labor stated up front

> "Man-computer symbiosis is an expected development in cooperative interaction between
> men and electronic computers. It will involve very close coupling between the human and
> the electronic members of the partnership. The main aims are 1) to let computers
> facilitate formulative thinking as they now facilitate the solution of formulated
> problems, and 2) to enable men and computers to cooperate in making decisions and
> controlling complex situations without inflexible dependence on predetermined programs.
> **In the anticipated symbiotic partnership, men will set the goals, formulate the
> hypotheses, determine the criteria, and perform the evaluations. Computing machines
> will do the routinizable work that must be done to prepare the way for insights and
> decisions in technical and scientific thinking.**"

### 2.2 The fig tree / fig wasp symbiosis metaphor (Section 1.1, "Symbiosis")

> "The fig tree is pollinated only by the insect *Blastophaga grossorun*. The larva of
> the insect lives in the ovary of the fig tree, and there it gets its food. The tree and
> the insect are thus heavily interdependent: **the tree cannot reproduce without the
> insect; the insect cannot eat without the tree; together, they constitute not only a
> viable but a productive and thriving partnership.** This cooperative 'living together in
> intimate association, or even close union, of two dissimilar organisms' is called
> symbiosis [27]."

> "Man-computer symbiosis is a subclass of man-machine systems. There are many man-machine
> systems. At present, however, there are no man-computer symbioses... The hope is that,
> in not too many years, **human brains and computing machines will be coupled together
> very tightly, and that the resulting partnership will think as no human brain has ever
> thought and process data in a way not approached by the information-handling machines we
> know today.**"

What the metaphor implies about division of labor: it is explicitly NOT "mechanically
extended man" (a human operator supplying all initiative/direction/integration while
equipment just extends reach or amplifies a signal) and NOT "artificial intelligence" (a
machine that fully substitutes for human thought). Symbiosis is a third category — mutual
dependence between two dissimilar kinds of "organism," each contributing what it is suited
for, neither able to do the whole job alone. Section 1.2 makes this contrast explicit:

> "As a concept, man-computer symbiosis is different in an important way from what North
> [21] has called 'mechanically extended man.' In the man-machine systems of the past, the
> human operator supplied the initiative, the direction, the integration..."

### 2.3 What each party does — "Separable Functions" (Section 4)

The complementarity principle, stated as a general observation before the division of
labor:

> "Computing machines can do readily, well, and rapidly many things that are difficult or
> impossible for man, and men can do readily and well, though not rapidly, many things
> that are difficult or impossible for computers. That suggests that a symbiotic
> cooperation, if successful in integrating the positive characteristics of men and
> computers, would be of great value."

Then the explicit division (Section 4, "Separable Functions of Men and Computers in the
Anticipated Symbiotic Association"):

> "Men will set the goals and supply the motivations, of course, at least in the early
> years. **They will formulate hypotheses. They will ask questions.** They will think of
> mechanisms, procedures, and models. They will remember that such-and-such a person did
> some possibly relevant work on a topic of interest back in 1947... and they will have an
> idea in what journals it might have been published. In general, **they will make
> approximate and fallible, but leading, contributions, and they will define criteria and
> serve as evaluators**, judging the contributions of the equipment and guiding the general
> line of thought. In addition, men will handle the very-low-probability situations when
> such situations do actually arise... Men will fill in the gaps, either in the problem
> solution or in the computer program, when the computer has no mode or routine that is
> applicable in a particular circumstance."

> "**The information-processing equipment, for its part, will convert hypotheses into
> testable models and then test the models against data** (which the human operator may
> designate roughly and identify as relevant when the computer presents them for his
> approval). **It will answer questions. It will simulate the mechanisms and models, carry
> out the procedures, and display the results to the operator.** It will transform data,
> plot graphs..."

**Relevance to the report's theme:** This is the clearest, most quotable 1960 statement of
"augmentation, not automation" division of labor — human judgment/goal-setting/evaluation
paired with machine execution of "routinizable work." It pre-dates Engelbart's 1962 paper
and is explicitly cited by Engelbart as a companion effort.

---

## 3. Douglas Engelbart, "Augmenting Human Intellect: A Conceptual Framework" (SRI Summary
Report AFOSR-3223, October 1962)

Source URL fetched: https://www.dougengelbart.org/pubs/augment-3906.html
(canonical permalink at the Doug Engelbart Institute; AUGMENT,3906,)

Note on method: the live page is a single very long HTML document (~300KB of text after
stripping markup/nav). I downloaded the raw HTML with `curl` and stripped tags with a
script rather than relying on the WebFetch tool's summarizer, which was truncating the
document before reaching Sections III and IV and paraphrasing rather than quoting. All
quotes below are exact, pulled directly from the stripped text with statement-ID (SID)
references (e.g. "1a10", "2c13") that are Engelbart's own paragraph-numbering scheme,
usable as a locator within the page.

### 3.1 What "augmenting human intellect" means, and the thesis that changes must be
integrated (not "isolated clever tricks") — Section I.A, General

> "By 'augmenting human intellect' we mean increasing the capability of a man to approach
> a complex problem situation, to gain comprehension to suit his particular needs, and to
> derive solutions to problems. Increased capability in this respect is taken to mean a
> mixture of the following: more-rapid comprehension, better comprehension, the
> possibility of gaining a useful degree of comprehension in a situation that previously
> was too complex, speedier solutions, better solutions, and the possibility of finding
> solutions to problems that before seemed insoluble." (SID 1a)

> "**We do not speak of isolated clever tricks that help in particular situations. We
> refer to a way of life in an integrated domain where hunches, cut-and-try, intangibles,
> and the human 'feel for a situation' usefully co-exist with powerful concepts,
> streamlined terminology and notation, sophisticated methods, and high-powered electronic
> aids.**" (SID 1a)

This is the closest thing in the paper to the thesis distinction the task asked for: real
augmentation is a *whole way of working* (concepts + notation + method + tool acting
together), explicitly contrasted with one-off "clever tricks" (i.e., point automations
bolted onto old methods).

### 3.2 The H-LAM/T system — exact definition

Section II.A, "General" (SID 2a13):

> "We assume that it is our **H-LAM/T system (Human using Language, Artifacts,
> Methodology, in which he is Trained)** that has the capability and that performs the
> process in any instance of use of this repertoire."

Engelbart immediately grounds this in a mundane example — writing a memo — to show how
language (the concept "memorandum"), artifacts, and trained method are inseparable
components of even a simple human capability (SID 2a13-2a14).

### 3.3 The capability/structuring hierarchy — concept, symbol, process (and mental,
physical) structuring

Section II.C.5.c, "Detailed Discussion of Structure Types" (SID 2c5c1c):

> "We use the terms 'mental structuring,' 'concept structuring,' 'symbol structuring,'
> 'process structuring,' and 'physical structuring.'"

**Concept structuring** (SID 2c5c3):

> "We view a concept as a tool that can be grasped and used by the mental mechanisms, that
> can be composed, interpreted, and used by the natural mental substances and processes...
> **Concepts seem to be structurable, in that a new concept can be composed of an
> organization of established concepts.**"

**Symbol structuring** (SID 2c5c4), including the exact paper-vs-screen example the task
asked for:

> "The other important part of our 'language' is the way in which concepts are
> represented—the symbols and symbol structures. Words structured into phrases,
> sentences, paragraphs, monographs—charts, lists, diagrams, tables, etc. A given
> structure of concepts can be represented by any of an infinite number of different
> symbol structures, some of which would be much better than others for enabling the
> human perceptual and cognitive apparatus to search out and comprehend the conceptual
> matter of significance..."

> "**We are generally used to thinking of our symbol structures as a pattern of marks on
> a sheet of paper. When we want a different symbol-structure view, we think of shifting
> our point of attention on the sheet, or moving a new sheet into position.** But another
> kind of view might be obtained by extracting and ordering all statements in the local
> text that bear upon consideration A of the argument—or by replacing all occurrences of
> specified esoteric words by one's own definitions. **This sort of 'view generation'
> becomes quite feasible with a computer-controlled display system, and represents a
> very significant capability to build upon.**" (SID 2c5c4c)

> "**With a computer manipulating our symbols and generating their portrayals to us on a
> display, we no longer need think of our looking at the symbol structure which is
> stored—as we think of looking at the symbol structures stored in notebooks, memos, and
> books.** What the computer actually stores need be none of our concern, assuming that it
> can portray symbol structures to us that are consistent with the form in which we think
> our information is structured." (SID 2c5c4d)

> "A given concept structure can be represented with a symbol structure that is completely
> compatible with the computer's internal way of handling symbols... **this structuring
> has immensely greater potential for accurately mapping a complex concept structure than
> does a structure an individual would find it practical to construct or use on paper.**"
> (SID 2c5c4e)

**Process structuring** (SID 2c5c5a):

> "As we are currently using it, the term process structuring includes the organization,
> study, modification, and execution of processes and process structures... **Whereas
> concept structuring and symbol structuring together represent the language component of
> our augmentation means, process structuring represents the methodology component (plus
> a little more, actually).**"

### 3.4 The "Joe" example

Correction of the task's framing: the well-known extended narrative in Section III.B
("Hypothetical Description of Computer-Based Augmentation System") is narrated by a
hypothetical demonstrator named **Joe** — Engelbart's device for walking the reader through
a future augmented workstation via a fictional first-person demo, not an architect. The
architect example (unnamed) is a separate, earlier illustration in Section I.A.

**Setup for "Joe" (SID 3b3):**

> "...we shall present the following picture of computer-based augmentation possibilities
> by describing what might happen if you were being given a personal discussion-
> demonstration by a friendly fellow (**named Joe**) who is a trained and experienced user
> of such an augmentation system within an experimental research program which is several
> years beyond our present stage."

Joe's working setup (SID 3b3b):

> "Joe has two display screens side by side... And the screens are almost horizontal, more
> like the surface of a drafting table than the near-vertical picture displays you had
> somehow imagined... he is working on the display surface as intently as a draftsman
> works on his drawings... Some of the time Joe is using both hands on the keys, obviously
> feeding information into the computer at a great rate."

Joe's demonstration of self-tracking/reflective process improvement, illustrating
augmentation applied reflexively to the user's own work habits (SID 3b8p-q):

> "Last winter, we designed a computer process that can automatically monitor the
> occurrence of specified types of computer usage over a specified period of time, and
> which, from the resulting data, can deduce a surprising amount of information regarding
> how the human made use of that time... Now, as part of my regular practice, I spend
> about five minutes out of each hour exercising with this package. This almost always
> reveals things to me that change at least the slant of my approach during the next
> hour, and often stimulates a relatively significant change in my short-range plans."

**The separate, unnamed architect example (Section I.A, SID 1a10-1a18)** — this is the one
usually cited as "the architect" and is what the task description points to:

> "Let us consider an augmented architect at work. He sits at a working station that has a
> visual display screen some three feet on a side; this is his working surface, and is
> controlled by a computer (his 'clerk') with which he can communicate by means of a small
> keyboard and various other devices." (SID 1a10)

> "He is designing a building. He has already dreamed up several basic layouts and
> structural forms, and is trying them out on the screen. The surveying data for the
> layout he is working on now have already been entered..." (SID 1a11)

> "Gradually the screen begins to show the work he is doing—a neat excavation appears in
> the hillside, revises itself slightly, and revises itself again... A few minutes of
> study, and he enters on the keyboard a list of items, checking each one as it appears on
> the screen, to be studied later." (SID 1a12)

> "...he examines it, adjusts it, pauses long enough to ask for handbook or catalog
> information from the clerk at various points, and readjusts accordingly." (SID 1a13)

> "Finally he has the 'clerk' combine all of these sequences of activity to indicate spots
> where traffic is heavy in the building, or where congestion might occur, and to
> determine what the severest drain on the utilities is likely to be." (SID 1a17,
> partial)

> "**All of this information (the building design and its associated 'thought structure')
> can be stored on a tape to represent the design manual for the building. Loading this
> tape into his own clerk, another architect, a builder, or the client can maneuver within
> this design manual to pursue whatever details or insights are of interest to him—and
> can append special notes that are integrated into the design manual for his own or
> someone else's later benefit.**" (SID 1a17-1a18)

**What it illustrates:** the architect isn't just drawing faster — the display/computer
system lets him manipulate an underlying model (structure, cost, traffic flow, utility
load) directly and iteratively, externalizing calculation and bookkeeping so that his
attention stays on design judgment; and the resulting artifact (the "design manual" with
its "associated thought structure") becomes a shared, navigable, annotatable symbol
structure other people can enter and extend — not just a finished drawing. This is
Engelbart's concrete picture of augmented **symbol manipulation**: the computer holds and
transforms the underlying structure (surveying data → 3D form → derived analyses) while
constantly re-rendering whatever partial "view" of it the human needs next.

### 3.5 Bootstrapping and the A/B/C activity classification — important caveat

**Caveat for accuracy:** the *canonical* "A activity / B activity / C activity" vocabulary
(A = the organization's actual production work, B = activity that improves how A is done,
C = activity that improves how B itself is done) that is widely attributed to Engelbart is
from his **later** writing (chiefly the 1990s Bootstrap Institute materials, e.g.
"Toward High-Performance Organizations: A Strategic Role for Groupware," 1992, and the
"ABC Model" material on dougengelbart.org's Vision pages, e.g.
https://www.dougengelbart.org/content/view/192/165/ — "ABC Model" / "ABC Advantage" /
"ABC Multipliers"). **The 1962 "Augmenting Human Intellect" paper itself does not use
that A/B/C terminology** — I verified this directly: the words "bootstrap"/"bootstrapping"
and the exact phrase "Activity A/B/C" do not appear in the 1962 paper's body text at all
except in one place, described below. (I grepped the full downloaded text; zero hits for
"bootstrap" and "Activity B"/"Activity C" outside of site navigation menus added by the
modern web page around the original 1962 text.)

What the 1962 paper *does* contain is the direct seed of the idea, under a different name:
**"regenerative" / "positive-feedback"** improvement, and a numbered-activity research plan
(A1, A2, A3, A4) in Section IV where the paper's single explicit use of "bootstrap*"
appears. This is the passage that should be cited for this concept from the primary 1962
source:

**Section IV.D, "Basic Regenerative Feature" (SID 4d):**

> "The feature brought forth in Reason 9 above is something that offers tremendous value
> to the research objectives—i.e., **the feeding back of positive research results to
> improve the means by which the researchers themselves can pursue their work.** ... This
> positive-feedback (or regenerative) possibility derives from the facts that: (1) our
> researchers are developing means to increase the effectiveness of humans dealing with
> complex intellectual problems, and (2) our researchers are dealing with complex
> intellectual problems. In other words, **they are developing better tools for a class to
> which they themselves belong.**"

**Section IV.E, "Tools Developed and Tools Used" (SID 4e):**

> "This close similarity between tools being developed and the tools being used to do the
> developing, calls for some care in our terminology... 'Augmentation means' will be used
> to name the tools being developed by the augmentation research... 'Tools and techniques'
> will be used to name the tools being used to do that research."

**Section IV.G, "A Second Phase in the Research Program" — the actual sentence using
"bootstraps" (SID 4g6):**

> "It is obvious that this report stems from generalized 'large-view' thinking... **Activity
> A2 is lifting itself by the bootstraps up the scale of intellectual capability, and its
> products are siphoned to the world via A3.**"

The numbered-activity structure here is: **A1** = the initial research activity (augmenting
programmers, testing the basic hypothesis); in the second phase this splits into **A2**
(develops augmentation means/tools and techniques for use by the researchers themselves —
i.e., improving the improvement process) and **A3** (turns A2's output into real-world
deployable augmentation systems for the world); **A4** is sketched as the eventual
application to society's most critical problems. So the *shape* of the A/B/C idea —
recursive self-improvement, tools that improve the tools that do the work — is present and
explicit in 1962 (A2 "lifting itself by the bootstraps," feeding back into A1/A2's own
methods), but the clean "A/B/C" three-tier label with that exact naming is a later
formulation. A report citing "the A/B/C activity classification" as 1962-Engelbart
vocabulary should flag this distinction or cite the 1990s bootstrapping material
specifically.

### 3.6 Summary section — restating the hypothesis (Section V)

> "This report has treated one over-all view of the augmentation of human intellect...
> **An hypothesis has been stated that the intellectual effectiveness of a human can be
> significantly improved by an engineering-like approach toward redesigning [the]
> changeable components** [of the human/tool/language/method system]..." (SID 5, 5a —
> quote truncated by a mid-sentence page-structure artifact in the source but the meaning
> is unambiguous from context: augmentation is an *engineering redesign of the whole
> system*, not a single tool swap.)

---

## Cross-source synthesis note (for the report writer)

- **Bush (1945)** establishes the *problem*: information overload, and the *design
  principle* that a machine for thought should mirror the mind's associative structure
  instead of imposing rigid hierarchy — "trails," not "trees."
- **Licklider (1960)** establishes the *division of labor*: humans set goals, form
  hypotheses, judge and evaluate; machines do routinizable execution — "symbiosis," not
  substitution, and explicitly not "mechanically extended man" or "artificial
  intelligence."
- **Engelbart (1962)** generalizes both into a full research program: the human is
  augmented as a *whole system* (H-LAM/T — language, artifacts, methodology, training
  together), the augmentation acts across a *hierarchy* of structuring (concept → symbol →
  process), illustrated concretely by the unnamed architect and the "Joe" demo, and the
  research effort is explicitly designed to be *self-improving* (the "regenerative"
  feature / bootstraps passage in Section IV, later formalized as the A/B/C model).
  Engelbart's clearest general statement against point-automation ("isolated clever
  tricks") in favor of integrated redesign of concepts+language+method+tool together is
  the SID 1a passage quoted in 3.1 above.
