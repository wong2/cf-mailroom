import assert from "node:assert/strict";
import test from "node:test";
import {
  linkifyPlainText,
  removeRedundantGoogleRedirects,
  unwrapGoogleRedirect,
} from "../src/shared/linkify.ts";

test("linkifies explicit web URLs while preserving surrounding text", () => {
  assert.deepEqual(linkifyPlainText("Read https://example.com/docs and www.example.org."), [
    { type: "text", value: "Read " },
    { type: "link", value: "https://example.com/docs", href: "https://example.com/docs" },
    { type: "text", value: " and " },
    { type: "link", value: "www.example.org", href: "https://www.example.org" },
    { type: "text", value: "." },
  ]);
});

test("keeps balanced URL punctuation and excludes sentence punctuation", () => {
  assert.deepEqual(linkifyPlainText("See https://example.com/a_(b)). Next step."), [
    { type: "text", value: "See " },
    { type: "link", value: "https://example.com/a_(b)", href: "https://example.com/a_(b)" },
    { type: "text", value: "). Next step." },
  ]);
});

test("does not turn the www portion of an email address into a link", () => {
  assert.deepEqual(linkifyPlainText("Contact hello@www.example.com"), [
    { type: "text", value: "Contact hello@www.example.com" },
  ]);
});

test("does not allow non-web protocols", () => {
  assert.deepEqual(linkifyPlainText("javascript:alert(1) file:///tmp/a"), [
    { type: "text", value: "javascript:alert(1) file:///tmp/a" },
  ]);
});

test("removes a Gmail redirect only when it repeats the preceding URL", () => {
  const target = "https://mcpservers.org/servers/example";
  const redirect = `<https://www.google.com/url?q=${target}&source=gmail&sa=E>`;
  assert.equal(
    removeRedundantGoogleRedirects(`Current listing:\n${target}\n${redirect}\nThanks`),
    `Current listing:\n${target}\nThanks`,
  );
});

test("preserves a Google redirect when it is not a duplicate", () => {
  const redirect = "<https://www.google.com/url?q=https://example.com&source=gmail>";
  assert.equal(removeRedundantGoogleRedirects(`Open this:\n${redirect}`), `Open this:\n${redirect}`);
});

test("displays and links the destination of an inline Gmail redirect", () => {
  const target = "https://mcpservers.org/servers/darksider4all/leadgen-mcp";
  const wrapper = `https://www.google.com/url?q=${target}&source=gmail&ust=1792571765301000&sa=E`;
  assert.deepEqual(linkifyPlainText(`Our listing at ${wrapper} still shows an old description:`), [
    { type: "text", value: "Our listing at " },
    { type: "link", value: target, href: target },
    { type: "text", value: " still shows an old description:" },
  ]);
});

test("decodes q and url targets once per wrapper, preserving destination query and fragment", () => {
  const target = "https://example.com/a%2Fb?tag=a%2Bb&next=%26value#section";
  for (const key of ["q", "url"]) {
    const wrapper = `https://google.com/url?${key}=${encodeURIComponent(target)}&source=gmail`;
    assert.equal(unwrapGoogleRedirect(wrapper), target);
    assert.equal(
      unwrapGoogleRedirect(`https://www.google.com/url?q=${encodeURIComponent(wrapper)}`),
      target,
    );
  }
});

test("preserves unknown wrappers, invalid targets, and non-web or credential-bearing targets", () => {
  for (const value of [
    "https://example.com/?q=https://target.example",
    "https://www.google.com.evil.example/url?q=https://target.example",
    "https://www.google.com/search?q=https://target.example",
    "https://www.google.com/url",
    "https://www.google.com/url?q=not-a-url",
    "https://www.google.com/url?q=www.example.com",
    "https://www.google.com/url?q=javascript:alert(1)",
    "https://www.google.com/url?q=data:text/html,test",
    "https://www.google.com/url?q=mailto:user@example.com",
    "https://www.google.com/url?q=https://user:pass@example.com",
    "https://user:pass@www.google.com/url?q=https://example.com",
  ]) {
    assert.equal(unwrapGoogleRedirect(value), value);
  }
});

test("keeps angle brackets and punctuation around a decoded link", () => {
  const wrapper = "www.google.com/url?url=https%3A%2F%2Fexample.com%2F";
  assert.deepEqual(linkifyPlainText(`See <${wrapper}>.`), [
    { type: "text", value: "See <" },
    { type: "link", value: "https://example.com/", href: "https://example.com/" },
    { type: "text", value: ">." },
  ]);
});

test("deduplicates encoded redirects using the same target extraction", () => {
  const target = "https://example.com/?a=1&b=2";
  assert.equal(
    removeRedundantGoogleRedirects(`${target}\n<https://google.com/url?url=${encodeURIComponent(target)}>`),
    target,
  );
});
