# Working specs — learned practices

The design is argued in
[`../2026-09-03-learned-practices-design.md`](../2026-09-03-learned-practices-design.md). **Read that
first.** It is the document a reviewer needs; these five are the ones an implementer needs.

They are working specs, written in parallel by separate authors and reconciled by review, then
committed unedited apart from path rewriting. That means they are more detailed and less tidy than
the design doc — roughly 5,200 lines against its 717 — and they carry the material it deliberately
compressed:

| Spec | What only this file has |
|---|---|
| [`10-schema.md`](10-schema.md) | the clause frontmatter field by field, each with its consumer; the write boundary's four rejections; the compiled artifact's shape |
| [`11-pipeline.md`](11-pipeline.md) | the eleven candidate detectors with thresholds and which need a model; **the generalisation lattice's seven widening levels**; the `launchd` install |
| [`12-validation.md`](12-validation.md) | the gate's `E1`-`E12` and `AR1`-`AR4` taxonomy, and the five reproduced bugs each code exists for; the replay and ablation report formats |
| [`13-governance.md`](13-governance.md) | the three user-profile walkthroughs with their transcripts; the dashboard-issue and PR templates; the revocation lifecycle |
| [`14-runtime-and-dashboard.md`](14-runtime-and-dashboard.md) | the measured latency and cost budgets; the two-region prompt split; the dashboard's routes and views |

Between them they carry roughly 200 numbered test invariants. Those are the acceptance criteria, and
they are the reason these files are worth committing rather than summarising.

## Two warnings

**Where these disagree with the design doc, the design doc wins.** Five contradictions about the
compiled artifact were settled after these were written; the rulings and their reasoning are in the
design doc's *"The compiled artifact, settled"* section. The affected passages here were updated, but
a residual disagreement is likelier here than there.

**A spec is not a promise.** Every number these files call a guess is a guess — most importantly
`~2 instruction-equivalents per rendered clause`, from which the clause ceiling of 25 is derived. The
measurement that would replace it is named where it appears.
