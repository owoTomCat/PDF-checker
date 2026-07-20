export function minimalPdfBytes() {
  const encoder = new TextEncoder();
  const content = "0.9 g\n0 0 72 72 re f\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources << >> /Contents 4 0 R >>",
    `<< /Length ${encoder.encode(content).byteLength} >>\nstream\n${content}endstream`,
  ];

  const chunks = ["%PDF-1.7\n"];
  const offsets = [0];
  let byteLength = encoder.encode(chunks[0]).byteLength;

  objects.forEach((object, index) => {
    offsets.push(byteLength);
    const chunk = `${index + 1} 0 obj\n${object}\nendobj\n`;
    chunks.push(chunk);
    byteLength += encoder.encode(chunk).byteLength;
  });

  const xrefOffset = byteLength;
  const xrefEntries = offsets
    .slice(1)
    .map((offset) => `${offset.toString().padStart(10, "0")} 00000 n \n`)
    .join("");
  chunks.push(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${xrefEntries}` +
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`,
  );

  return encoder.encode(chunks.join(""));
}
