/**
 * Regenerates dashboard_template.ts from dashboard.html.
 *
 * dashboard.html is the editable source; dashboard_template.ts is the
 * committed artifact that main.ts imports, so the template ships with both
 * the gh extension (git clone) and the JSR package without needing
 * runtime file reads or unstable raw imports.
 *
 * Run after editing dashboard.html: deno task template
 */

export async function generateTemplateModule(): Promise<string> {
  const html = await Deno.readTextFile(
    new URL("../dashboard.html", import.meta.url),
  );
  return [
    "// AUTO-GENERATED from dashboard.html — do not edit by hand.",
    "// Regenerate with: deno task template",
    `export const DASHBOARD_TEMPLATE: string = ${JSON.stringify(html)};`,
    "",
  ].join("\n");
}

if (import.meta.main) {
  await Deno.writeTextFile(
    new URL("../dashboard_template.ts", import.meta.url),
    await generateTemplateModule(),
  );
  console.log("dashboard_template.ts regenerated");
}
