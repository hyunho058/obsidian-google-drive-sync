/**
 * TT9: acceptance tests for R9 (D21) and R0.3 — the README and source text
 * describe full Drive access honestly and list the new limits.
 *
 * R9.4 (the settings tab's credentials help names the unverified-app warning)
 * is a manual check on a desktop settings tab and is not asserted here.
 *
 * Reads README.md and every .ts file under src/ from disk; the runner runs
 * the bundle with the repo root as the working directory.
 */
import * as fs from "fs";
import * as path from "path";
import { test, assert, run } from "./harness";

const ROOT = process.cwd();
const README_PATH = path.join(ROOT, "README.md");

function readme(): string {
  return fs.readFileSync(README_PATH, "utf8");
}

function srcFiles(dir = path.join(ROOT, "src")): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...srcFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out.sort();
}

/** README.md plus every src/**\/*.ts, as [relative path, text]. */
function allDocs(): Array<[string, string]> {
  return [README_PATH, ...srcFiles()].map((f) => [
    path.relative(ROOT, f),
    fs.readFileSync(f, "utf8"),
  ]);
}

type Section = { level: number; heading: string; body: string };

/**
 * Splits markdown on `## ` and `### ` headings. A section's body runs until
 * the next heading of the same or a higher level, so a `##` section includes
 * its `###` subsections.
 */
function sections(md: string): Section[] {
  const lines = md.split(/\r?\n/);
  const heads: Array<{ idx: number; level: number; heading: string }> = [];
  lines.forEach((line, idx) => {
    const m = /^(#{2,3})\s+(.*)$/.exec(line);
    if (m) heads.push({ idx, level: m[1].length, heading: m[2].trim() });
  });
  return heads.map((h, i) => {
    let end = lines.length;
    for (let j = i + 1; j < heads.length; j++) {
      if (heads[j].level <= h.level) {
        end = heads[j].idx;
        break;
      }
    }
    return { level: h.level, heading: h.heading, body: lines.slice(h.idx + 1, end).join("\n") };
  });
}

function section(md: string, heading: RegExp, what: string): Section {
  const s = sections(md).find((x) => heading.test(x.heading));
  assert(s, `README has no section whose heading matches ${heading} (${what})`);
  return s as Section;
}

// ── R9.1 ────────────────────────────────────────────────────────────────────

test("R9.1 no text claims the scope is non-sensitive or review-free", () => {
  const bad = /non-sensitive|no verification review|with no review/i;
  const hits: string[] = [];
  for (const [file, text] of allDocs()) {
    text.split(/\r?\n/).forEach((line, i) => {
      if (bad.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert(hits.length === 0, `found review-free/non-sensitive claims:\n     ${hits.join("\n     ")}`);
});

// ── R9.2 ────────────────────────────────────────────────────────────────────

test("R9.2 'How it works' names the full-Drive scope auth/drive (not drive.file)", () => {
  const s = section(readme(), /^how it works\b/i, "How it works");
  assert(
    /auth\/drive(?![.\w])/.test(s.body),
    "'How it works' does not mention the full-Drive scope `auth/drive`",
  );
});

test("R9.2 the Google Cloud setup section mentions \"hasn't verified\"", () => {
  const s = section(readme(), /google cloud|cloud setup/i, "Cloud setup");
  assert(/hasn['’]t verified/i.test(s.body), "Cloud setup section does not mention \"hasn't verified\"");
});

test("R9.2 a 'Syncing a shared folder' heading exists", () => {
  const found = sections(readme()).some((s) => /syncing a shared folder/i.test(s.heading));
  assert(found, "README has no '## / ### Syncing a shared folder' heading");
});

test("R9.2 'Known limits' mentions 0.3.0", () => {
  const s = section(readme(), /^known limits\b/i, "Known limits");
  assert(/0\.3\.0/.test(s.body), "'Known limits' does not mention 0.3.0");
});

// ── R9.3 ────────────────────────────────────────────────────────────────────

function knownLimits(): string {
  return section(readme(), /^known limits\b/i, "Known limits").body;
}

test("R9.3 Known limits: Google Docs, Sheets and Slides are skipped", () => {
  const body = knownLimits();
  assert(
    /google docs/i.test(body) && /sheets/i.test(body) && /slides/i.test(body) && /skip/i.test(body),
    "Known limits does not say Google Docs/Sheets/Slides are skipped",
  );
});

test("R9.3 Known limits: files owned by someone else come back after a delete", () => {
  const body = knownLimits();
  assert(
    /(owned by (someone|somebody|another|others?)|someone else['’]s|other people['’]s)/i.test(body) &&
      /(come[s]? back|brings? (them|it) back|restored|reappear|re-?download)/i.test(body),
    "Known limits does not say files owned by someone else come back after a delete",
  );
});

test("R9.3 Known limits: a view-only folder is refused", () => {
  const body = knownLimits();
  assert(
    /(view-?only|read-?only|viewer)/i.test(body) && /(refuse|reject|not (be )?(allowed|accepted)|won['’]t)/i.test(body),
    "Known limits does not say a view-only folder is refused",
  );
});

test("R9.3 Known limits: both devices need 0.3.0 or later", () => {
  const body = knownLimits();
  assert(
    /0\.3\.0 (or later|or newer|or above|\+)|0\.3\.0\+|at least 0\.3\.0/i.test(body),
    "Known limits does not say devices need 0.3.0 or later",
  );
});

test("R9.3 Known limits no longer says drive.file cannot see files it did not create", () => {
  const body = knownLimits();
  assert(
    !/cannot see files it did not create/i.test(body),
    "Known limits still says `drive.file` cannot see files it did not create",
  );
});

// ── R0.3 ────────────────────────────────────────────────────────────────────

test("R0.3 no text claims drive.file is the scope in use", () => {
  const historical = /no longer|instead of|could not|cannot|can['’]t|\bwas\b|older|used to/i;
  const hits: string[] = [];
  for (const [file, text] of allDocs()) {
    text.split(/\r?\n/).forEach((line, i) => {
      if (line.includes("drive.file") && !historical.test(line)) {
        hits.push(`${file}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert(hits.length === 0, `lines mention drive.file without a historical word:\n     ${hits.join("\n     ")}`);
});

void run();
