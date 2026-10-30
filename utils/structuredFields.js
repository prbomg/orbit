// RFC 8941 string serialization shared by passport generation, validation and HTTP.
function quoted(value) {
  if (value == null) throw new Error('Missing Client Hint string');
  const text = String(value);
  if (/[^\x20-\x7e]/.test(text)) throw new Error('Invalid Client Hint string');
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
function formatBrandList(brands = []) {
  if (!Array.isArray(brands)) throw new Error('Invalid Client Hint brand list');
  return brands.map(row => {
    if (!row || row.brand == null || row.version == null) throw new Error('Invalid Client Hint brand');
    return `${quoted(row.brand)};v=${quoted(row.version)}`;
  }).join(', ');
}
module.exports = { quoted, formatBrandList };
