import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../services/atlassian/ui/markdown.js';

test('escapes HTML so page text cannot inject markup', () => {
  assert.equal(renderMarkdown('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.equal(renderMarkdown('[x](javascript:alert(1))'), '<p><a href="#">x</a>)</p>');
});

test('renders headings, lists, code and inline marks', () => {
  const html = renderMarkdown('# Title\n\n- **bold** and `code`\n- [ ] todo\n\n1. one\n2. two\n\n```\na < b\n```');
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<li><strong>bold<\/strong> and <code>code<\/code><\/li>/);
  assert.match(html, /<li class="task"><input type="checkbox" disabled> todo<\/li>/);
  assert.match(html, /<ol><li>one<\/li><li>two<\/li><\/ol>/);
  assert.match(html, /<pre><code>a &lt; b<\/code><\/pre>/);
});

test('renders tables', () => {
  const html = renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |');
  assert.equal(html, '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>');
});
