// Self-contained transactional email renderer. Dynamic values are escaped once.
const shell = String.raw`<!doctype html>
<html lang="@@LANG@@"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>@@TITLE@@</title>
<style>body{margin:0;padding:0}table{border-collapse:collapse}a{color:@@ACCENT@@}p{margin:0 0 18px} @media(max-width:620px){.outer{padding:24px 12px!important}.content{padding:28px 24px!important}.heading{font-size:28px!important;line-height:34px!important}.brand{padding:24px!important}.footer{padding:24px 12px!important}} @media(prefers-color-scheme:dark){.canvas{background:#101923!important}.card,.brand{background:#172431!important}.ink{color:#f0f5fa!important}.copy{color:#c1cdd9!important}.muted{color:#a5b6c7!important}.panel{background:#213342!important;border-color:#3c5568!important}.rule{border-color:#334756!important}.url{color:#9ddbeb!important}}</style></head>
<body class="canvas" style="background:#f1f4f7;color:#172b3d;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">@@PREHEADER@@</div>
<table role="presentation" width="100%" class="canvas" style="background:#f1f4f7;"><tr><td class="outer" align="center" style="padding:40px 16px;">
<!--[if mso]><table role="presentation" width="600" align="center"><tr><td><![endif]-->
<table role="presentation" width="100%" class="card" style="max-width:600px;background:#ffffff;border:1px solid #dce4eb;border-radius:16px;">
<tr><td style="height:5px;background:@@ACCENT@@;font-size:1px;line-height:5px;">&nbsp;</td></tr>
<tr><td class="brand rule" style="padding:28px 36px;border-bottom:1px solid #e5ebf0;"><table role="presentation" width="100%"><tr><td width="44" style="width:44px;"><table role="presentation"><tr><td align="center" width="40" height="40" style="width:40px;height:40px;background:@@ACCENT@@;color:#ffffff;border-radius:10px;font-size:15px;font-weight:bold;letter-spacing:-.5px;">@@MONOGRAM@@</td></tr></table></td><td style="padding-left:12px;"><div class="muted" style="font-size:10px;line-height:15px;letter-spacing:2px;color:#63788c;font-weight:bold;">ONESA</div><div class="ink" style="font-size:18px;line-height:24px;font-weight:bold;color:#172b3d;">@@BRAND@@</div></td></tr></table></td></tr>
<tr><td class="content" style="padding:36px;">
<p class="muted" style="font-size:11px;line-height:16px;letter-spacing:1.8px;color:#536b80;font-weight:bold;margin:0 0 14px;">@@LABEL@@</p>
<h1 class="heading ink" style="font-size:32px;line-height:39px;letter-spacing:-.8px;color:#172b3d;margin:0 0 24px;font-weight:700;overflow-wrap:anywhere;">@@HEADING@@</h1>
<div class="copy" style="font-size:16px;line-height:26px;color:#52677a;overflow-wrap:anywhere;word-break:break-word;">@@CONTENT@@</div>
@@ACTION@@
@@FALLBACK@@
</td></tr>
<tr><td class="panel rule" style="padding:20px 36px;background:@@SOFT@@;border-top:1px solid #e5ebf0;"><p class="muted" style="font-size:12px;line-height:20px;color:#5b7284;margin:0;">@@NOTE@@</p></td></tr>
</table>
<table role="presentation" width="100%" style="max-width:600px;"><tr><td class="footer muted" align="center" style="padding:24px 20px;color:#687e90;font-size:11px;line-height:19px;letter-spacing:.2px;">@@BRAND@@ &nbsp;&middot;&nbsp; ONESA<br>@@FOOTER@@</td></tr></table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table></body></html>`;
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const paragraphs = (value: string) => value.split(/\n\s*\n/).filter(p => p.trim()).map(p => `<p style="margin:0 0 18px;">${escapeHtml(p).replaceAll("\n", "<br>")}</p>`).join("");
function webOrigin(value: string): string | undefined {
  try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password ? u.origin : undefined; }
  catch { return undefined; }
}
function button(href: string | undefined, label: string, accent: string) {
  return href ? `<table role="presentation" style="margin:28px 0 8px;"><tr><td bgcolor="${accent}" style="background:${accent};border-radius:8px;mso-padding-alt:16px 24px;"><a href="${escapeHtml(href)}" style="display:inline-block;padding:16px 24px;color:#ffffff;font-size:15px;font-weight:bold;text-decoration:none;line-height:20px;border:1px solid ${accent};border-radius:8px;">${escapeHtml(label)} &nbsp;&#8594;</a></td></tr></table>` : "";
}
function fill(values: Record<string, string>): string {
  return shell.replace(/@@([A-Z]+)@@/g, (_, key: string) => values[key] ?? "");
}

export type FarmerEmailContent = { title: string; body: string; language?: string };
export function renderNotificationEmail(content: FarmerEmailContent, verification = false): string {
  const language = content.language === "nd" ? "nd" : content.language === "sn" ? "sn" : "en";
  const actionLabel = language === "nd" ? "Vula Smart Farmer" : language === "sn" ? "Vhura Smart Farmer" : "Open Smart Farmer";
  const origin = webOrigin(process.env.WEB_ORIGIN ?? "https://farmer.onesa.eu");
  const code = verification && /^\d{6}$/.test(content.body.trim());
  return fill({ LANG: language, TITLE: escapeHtml(content.title), PREHEADER: escapeHtml(content.title),
    BRAND: "Smart Farmer", MONOGRAM: "SF", ACCENT: "#286744", SOFT: "#f0f6ef", LABEL: "SMART FARMER",
    HEADING: escapeHtml(content.title),
    CONTENT: code ? `<div class="panel ink" style="padding:24px 16px;margin:4px 0 24px;background:#f0f6ef;border:1px solid #d5e3d5;border-radius:10px;text-align:center;font-family:Consolas,monospace;font-size:36px;line-height:44px;font-weight:bold;letter-spacing:6px;color:#234c35;">${escapeHtml(content.body.trim())}</div><p class="muted" style="font-size:13px;text-align:center;margin:0;">10 min</p>` : paragraphs(content.body),
    ACTION: button(origin, actionLabel, "#286744"), FALLBACK: "",
    NOTE: "Smart Farmer &nbsp;&middot;&nbsp; onesa.eu", FOOTER: "farmer.onesa.eu",
  });
}
