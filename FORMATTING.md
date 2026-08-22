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
- A cart screenshot is not a receipt. For delivery orders, ground macros on the post-checkout order page (DoorDash Order Complete / confirmation receipt) before logging - carts change at checkout (the 2026-08-21 Taco Bell cart showed a Cheesy Roll Up the real order never had). When the receipt and an earlier estimate disagree, the receipt wins and the wrong row gets deleted, not adjusted.

## Rule 8: name rows by specific brand + product name

Every row title carries the specific brand and full product name when one is established, in the form "Brand Product Name (amount)" - e.g. "Wildwood Organic High Protein Tofu, super firm (1/2 block)", not "Super firm tofu". If the brand isn't known, leave it generic and do not invent one. Venue items keep the venue-name-first form per Rule 5.

## Rule 9: the log is an ingredients list, not meals

The day breakdown reads as a list of ingredients, not meal names. Name rows like ingredients (product name first), never like dishes you assembled yourself ("stir fry", "bowl"). If he ate several things together, they are still one row per item per Rule 1. (Implementation note: the Log database's title property stays named "Meal" because the worker reads that property name; the content convention changes, not the schema.)

## Rule 10: every row carries its macro evidence

Every row must carry evidence for its numbers: a photo of the package label or supplier evidence (email or published page). The link or file goes in the row's Source URL property - label-photo link for pantry/home items, supplier product page for published-basis items, the supplier email for email-sourced numbers. If the only evidence is a prior established row, leave Source empty and keep the Items basis note naming that row. Never let a row's macros rest on an unlabeled claim.

## Known product bases (registry)

Established per-unit bases; always back into macros from these, never re-derive. Percentages/fractions stay exact per Rule 6.

- Barber's Sweet Red Cheddar: block = 780 kcal, 49.5g protein (manufacturer-confirmed 2026-08-17)
- Alexandre Family Farm A2 6% milk: carton = 1,620 kcal, 66g protein
- Sascha Fitness Hydrolyzed Whey Protein Isolate: 2 scoops (66g) = 220 kcal, 50g protein (110/25p per scoop)
- Kirkland Signature liquid egg whites: per serving (3 Tbsp / 46g) = 25 kcal, 5g protein, 1g carb, 75mg sodium
- Whole Foods Market Pasteurized Liquid Egg Whites: per serving (3 Tbsp / 46g) = 20 kcal, 5g protein, 80mg sodium (~10 servings per 16oz carton). Carton photoed 2026-08-21; owner confirmed carton is finished - historical rows on the Kirkland basis stand as logged. Use this basis for any future carton of this product; Kirkland stays the basis for Kirkland rows.
- Bragg Nutritional Yeast: per 2 Tbsp (10g) = 40 kcal, 5g protein, 3g carb, 2g fiber, 20mg sodium
- Springfield Creamery cottage cheese: per 1/2 cup (110g) = 80 kcal, 14g protein, 2g fat, 4g carb, 4g sugar, 300mg sodium
- Wildwood Organic High Protein Tofu (super firm): per 91g serving = 130 kcal, 14g protein, 7g fat (1.5g sat), 2g carb, 2g fiber, 10mg sodium; 5 servings per 16oz pack (block = 650 kcal, 70g protein)
- Hodo Organic Extra Firm Tofu: per 3oz (85g) serving = 120 kcal, 14g protein, 4.5g fat (0g sat), 6g carb, 2g fiber, 0mg sodium; ~3 servings per 10oz/284g pack (package-front badge says 48g protein per package). In pantry as of 2026-08-21, use-by 09/30/26, not yet eaten - first row gets created on first use.
- 365 by Whole Foods Market organic cage-free large brown eggs: per whole large egg = 70 kcal, 6g protein, 5g fat (1.5g sat), 70mg sodium
- Once Again Unsweetened Crunchy Peanut Butter (no salt added): per 2 Tbsp (32g) = 190 kcal, 8g protein, 14g fat (2g sat), 7g carb, 2g fiber, 2g sugar, 0mg sodium (label photo 2026-08-21, same values as the 2026-08-20 row)
- Siggi's nonfat plain skyr (0%): per 24oz tub basis per label (2026-08-13 row)
