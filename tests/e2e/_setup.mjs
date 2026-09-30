// Shared test setup. DeepPilot wraps text that comes from web pages in
// <untrusted_page_data id="…"> … </untrusted_page_data> markers (prompt-injection defence). The mock
// "brains" in these tests read tool results as JSON, so JSON.parse unwraps those markers first.
const parse = JSON.parse;
JSON.parse = (s, reviver) => parse(typeof s === 'string'
  ? s.replace(/^<untrusted_page_data[^>]*>\n/, '').replace(/\n<\/untrusted_page_data[^>]*>$/, '')
  : s, reviver);
