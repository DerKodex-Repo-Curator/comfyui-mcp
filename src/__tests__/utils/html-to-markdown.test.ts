import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../../utils/html-to-markdown.js";

describe("htmlToMarkdown", () => {
  it("returns empty string for empty/nullish input", () => {
    expect(htmlToMarkdown("")).toBe("");
    expect(htmlToMarkdown(undefined)).toBe("");
    expect(htmlToMarkdown(null)).toBe("");
  });

  it("converts inline emphasis and code", () => {
    expect(htmlToMarkdown("<strong>bold</strong>")).toBe("**bold**");
    expect(htmlToMarkdown("<b>bold</b>")).toBe("**bold**");
    expect(htmlToMarkdown("<em>it</em>")).toBe("_it_");
    expect(htmlToMarkdown("<code>x=1</code>")).toBe("`x=1`");
  });

  it("converts links to markdown, falling back to the href as text", () => {
    expect(htmlToMarkdown('<a href="https://x.io">site</a>')).toBe(
      "[site](https://x.io)",
    );
    expect(htmlToMarkdown('<a href="https://x.io"></a>')).toBe(
      "[https://x.io](https://x.io)",
    );
  });

  it("converts headings to ATX", () => {
    expect(htmlToMarkdown("<h2>Usage</h2>")).toBe("## Usage");
    expect(htmlToMarkdown("<h4>Notes</h4>")).toBe("#### Notes");
  });

  it("converts lists to dash bullets", () => {
    const md = htmlToMarkdown("<ul><li>one</li><li>two</li></ul>");
    expect(md).toBe("- one\n- two");
  });

  it("turns <br> and </p> into line/paragraph breaks", () => {
    expect(htmlToMarkdown("a<br>b")).toBe("a\nb");
    expect(htmlToMarkdown("<p>a</p><p>b</p>")).toBe("a\n\nb");
  });

  it("decodes common HTML entities", () => {
    expect(htmlToMarkdown("Tom &amp; Jerry &mdash; ok")).toBe(
      "Tom & Jerry — ok",
    );
    expect(htmlToMarkdown("&#65;&#x42;")).toBe("AB");
  });

  it("strips unknown tags but keeps their text", () => {
    expect(htmlToMarkdown('<span class="x">hi</span>')).toBe("hi");
    expect(htmlToMarkdown("<script>evil()</script>keep")).toBe("keep");
  });

  it("collapses excessive blank lines", () => {
    expect(htmlToMarkdown("<p>a</p><br><br><br><p>b</p>")).toBe("a\n\nb");
  });
});
