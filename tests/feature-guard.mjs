#!/usr/bin/env node
/* Feature-preservation guard: fails CI if a user-facing feature disappears
 * from the worker bundle. Each check names the feature it protects so a red
 * run says exactly what was lost. Run: node tests/feature-guard.mjs */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const src = readFileSync(new URL('../worker/worker.js', import.meta.url), 'utf8');
const appJsMatch = src.match(/const APP_JS = `([\s\S]*?)`;\nfunction appVer/);
const appJs = appJsMatch ? appJsMatch[1] : '';
const pageTpl = src.slice(src.indexOf('function chartPage'), src.indexOf('function loginPage'));

let failures = 0;
const check = (feature, ok, detail = '') => {
  if (ok) console.log(`  ok   ${feature}`);
  else { failures++; console.log(`  FAIL ${feature}${detail ? ': ' + detail : ''}`); }
};

console.log('== static feature markers ==');
check('Average modifier button (Macros seg)', /data-avg="1">Average</.test(pageTpl), 'data-avg="1">Average button missing from page template');
check('3 day selector', /data-w="3">3 day</.test(pageTpl));
check('7 day selector', /data-w="7">7 day</.test(pageTpl));
check('All time selector', /data-w="0">All time</.test(pageTpl));
check('Average modifier handler (app.js)', /dataset.avg/.test(appJs), 'avg modifier click handling missing from app.js');
check('Average numbers pane', /avgrow|avgpane|avgAlign/.test(src), 'average numbers pane markup/alignment missing');
check('Workout estimated burn in Calories blow-up', /Workout -/.test(appJs), '"Workout -N est" row missing');
check('Workout hatched bar segment', /bseg-wo/.test(src), 'bseg-wo hatch segment missing');
check('Workout split tabs are real links', /<a data-s="Push">Push<\/a><a data-s="Pull">Pull<\/a><a data-s="Legs">Legs<\/a>/.test(src));
check('Tab links keep embedded params client-side', /splitSlug/.test(appJs) && /metaKey \|\| ev\.ctrlKey/.test(appJs));
check('Blow-up empty state defined', /Nothing logged yet\./.test(appJs), 'empty_msg reference without definition');
check('Mixed-freshness guard in page build', /freshItems/.test(src), 'buildChartPage items-refetch guard missing');
check('Blow-up renderer present', /function blowPanel|blowPanel\s*=/.test(appJs + src));
check('Clear-view mask geometry', /eng\.smB = eng\.smB \|\| \[\]/.test(src) && /mask="url\(/.test(src), 'smB collect/masked emit pass missing - Clear bands will stack colors');
check('Clear avg band clips to next band top', /bandTops\[q\] !== null/.test(src), 'f2c2dd2 next-band-top clip missing');
check('Workout entry pane (record sheet)', /wkedit/.test(src));
check('workout.json endpoint', /workout\.json/.test(src));
check('data.json streams items live', /ITEMS/.test(appJs) && /items/.test(src));

console.log('== functional render test ==');
const tmp = mkdtempSync(join(tmpdir(), 'cbum-'));
const modPath = join(tmp, 'worker.mjs');
writeFileSync(modPath, src + '\nexport { chartPage };\n');
const mod = await import(pathToFileURL(modPath).href);
if (typeof mod.chartPage !== 'function') { failures++; console.log('  FAIL chartPage export'); }
else {
  const today = '2026-08-20';
  const rows = [{ date: today, calories: 500, protein: 40, carbs: 50, fat: 20, sugar: 10, sodium: 100, fiber: 5 }];
  const items = { [today]: [{ title: 'guard test meal', cal: 500, p: 40, c: 50, f: 20 }] };
  const wk = { splits: { Legs: [{ date: today, title: '', ex: { 'Ballerina Squat': [[135, 6]] }, w: { 'Ballerina Squat': 135 }, raw: {} }] }, errors: {} };
  const html = mod.chartPage(rows, { source: 'guard' }, wk, '', true, null, items);
  check('render: Average button in built HTML', html.includes('data-avg="1"'));
  check('render: time selector in built HTML', ['data-w="3"', 'data-w="7"', 'data-w="0"'].every(m => html.includes(m)));
  check('render: item rows embedded for blow-ups', html.includes('guard test meal'), 'items payload not baked into page');
  check('render: workout session embedded', html.includes('Ballerina Squat'), 'workout session payload not baked into page');
  check('render: split tabs markup', html.includes('data-s="Push"') && html.includes('data-s="Legs"'));
  check('render: /app.js script tag', html.includes('/app.js'));
  check('render: app bundle tag', html.includes('/app.js'));
}

console.log(failures ? `\n${failures} feature check(s) FAILED` : '\nall feature checks passed');
process.exit(failures ? 1 : 0);
