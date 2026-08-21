# Food Log Formatting Rules

This file is the contract for every agent that writes rows to the **Log** database. Read it before creating a row, every time. The README links here; do not rely on training-time memory of these rules. When the owner corrects a logging decision in chat, treat that correction as a new rule and add it here.

## Schema

The Log database columns:

| Column | Type | How to fill it |
|---|---|---|
| Meal | title | Item name **with the amount inline**, e.g. `Sweet red cheddar (20% of block)`, `A2 milk (1/3 of carton #2)`, `Whey isolate (2 scoops)`. One food per row. |
| Date | date | The day it was eaten (local). |
| Calories, Protein, Carbs, Fat, Saturated Fat, Sugar, Fiber, Sodium | number | Final numbers for what's actually in THIS row, already scaled. Units are the chart's defaults (kcal, g, mg for sodium). |
| Items | rich_text | The full, honest basis: what the amount means, where the macro numbers came from, every assumption. This is the audit trail - never leave it empty or vague. |
| Type | select | `Home - from Meals` / `Home - recipe` / `Home - improvised` / `Home - packaged label` / `Restaurant - published macros` / `Restaurant - estimated` / `Restaurant - listed`. |
| Source | url | The label/product page or restaurant menu/3rd-party nutrition page the numbers are anchored to, when one exists. |
| Day | relation | Link to the day row in the rollup database when you have it. |
| Recipe | relation | For `Home - recipe` rows, link the recipe. |

## Rule 1: one row per item

Every distinct food or drink gets its own row. Never merge a meal into one row ("dinner", "lunch"). The day blow-up on the chart shows the items, so row titles must stand alone.

## Rule 2: amount by fraction of the container

For bulk home items the owner eats over days, express the amount as a **percent/fraction of the named container** and bake that into the title and the Items text:

- cheese: `% of block`
- milk: `% of carton`

Do not convert to grams unless the owner gives grams. The fraction is what he actually tracks against.

## Rule 3: back into the macros from the first row

The **first-ever row for an item is its anchor**: it pins the full-container (or per-serving) macro total and the basis. Every later row for the same item scales straight off that anchor - same basis, new fraction. Do not re-derive from the label again, do not average sources, and do not change an anchor's numbers without saying so in Items.

Established anchors (do not silently change):

- Sweet red cheddar: 100% block = 780 kcal, 49.5g protein
- Alexandre A2 milk: full carton = 1,620 kcal, 66g protein
- Sascha Fitness whey isolate: 2 scoops = 220 kcal, 50g protein (per-scoop label 110 kcal/25g)

First-ever row for a packaged item: use the product's own label, cite it in Source, and record label-per-serving + serving count in Items so the next agent can scale it.

## Rule 4: milk is never "whole milk" at home

The home milk is **Alexandre Family Farm A2 6%**. Never call it "whole milk" in a title or basis - say "A2 milk" (or "Alexandre A2 6%"). A drink OUT that contains whole milk keeps the venue's own description (e.g. a cafe's "pandan banana matcha with whole milk" stays as the venue describes it).

## Rule 5: venues keep their own words

Restaurant/venue rows keep the venue's dish name and description in the title (e.g. `Sorella - Burrata, heirloom tomato & peach salad (small plate)`), prefixed with the venue. Pick the Type that matches the evidence: published macros only if the venue/vendor actually publishes them, else estimated - and say how the estimate was built in Items.

## Rule 6: fractional portions are exact numbers, honest basis

Log the fraction the owner actually said ("96% of one", "7/8 of the pie"), scale the anchor or published number by exactly that fraction, and put the exact wording + the arithmetic into Items. Only integers in the macro fields.

## Rule 7: agent conduct

- Never email or otherwise contact a company/vendor about nutrition info. Use published pages, labels on hand, or in-house anchors only. If numbers can't be grounded, estimate honestly and say so in Items - do not fabricate a "published" source.
- If the owner corrects a row, fix the row AND its Items basis, and if the correction generalizes, add the rule here.
