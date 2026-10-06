import { describe, expect, it } from "vitest";
import { englishRows, extractArticle, labelFor, parseCsv } from "./semeval";

describe("semeval", () => {
  it("parses quoted CSV fields", () => {
    expect(parseCsv('a,b\n"x,1","y ""q"""\n')).toEqual([["a", "b"], ["x,1", 'y "q"']]);
  });

  it("keeps only en-en rows and reads either score-column case", () => {
    const head = "url1_lang,url2_lang,pair_id,link1,link2,ia_link1,ia_link2,OVERALL\n";
    const rows = englishRows(head + "en,en,1_2,l1,l2,i1,i2,1.5\nde,en,3_4,l1,l2,i1,i2,2\n");
    expect(rows).toEqual([{ pairId: "1_2", link1: "l1", link2: "l2", iaLink1: "i1", iaLink2: "i2", overall: 1.5 }]);
  });

  it("labels the ends and drops the middle", () => {
    expect([labelFor(1), labelFor(2.5), labelFor(4)]).toEqual(["same", null, "different"]);
  });

  it("extracts title and description, rejects empty pages", () => {
    const html = '<meta property="og:title" content="A &amp; B"><meta property="og:description" content="' + "word ".repeat(30) + '">';
    expect(extractArticle(html)?.title).toBe("A & B");
    expect(extractArticle("<html></html>")).toBeNull();
  });
});
