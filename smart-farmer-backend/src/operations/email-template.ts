// Palette mirrors smart-farmer-frontend/web/src/style.css; email dark mode uses the same forest/cream colors.
// Self-contained transactional email renderer. Dynamic values are escaped once.
const shell = String.raw`<!doctype html>
<html lang="@@LANG@@"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>@@TITLE@@</title>
<style>body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}body{margin:0;padding:0}table{border-collapse:collapse}img{border:0;outline:none;text-decoration:none}a:focus-visible{outline:3px solid @@ACCENT@@;outline-offset:4px}p{margin:0 0 18px}@media(max-width:620px){.outer{padding:20px 12px!important}.content{padding:28px 22px!important}.heading{font-size:27px!important;line-height:33px!important}.footer{padding:24px 22px!important}}@media(prefers-color-scheme:dark){.canvas{background:#102119!important}.card{background:#173f2e!important;border-color:#64756b!important}.ink{color:#f5f6f1!important}.copy{color:#e8f1e5!important}.muted{color:#c0cfc2!important}.panel,.notice{background:#20382d!important;border-color:#e8f1e5!important}.rule{border-color:#64756b!important}.url{color:#e8f1e5!important}.accent-fill,.button{background:#e8f1e5!important;color:#173f2e!important}.button-label{color:#173f2e!important;border-color:#e8f1e5!important}}</style></head>
<body class="canvas" style="background:#f5f6f1;color:#20382d;font-family:Arial,Helvetica,sans-serif;">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;">@@PREHEADER@@</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="outer" align="center" style="padding:40px 16px;">
<!--[if mso]><table role="presentation" width="600" align="center"><tr><td><![endif]-->
<table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border:1px solid #dfe5dc;border-radius:16px;border-collapse:separate;border-spacing:0;">
<tr><td class="accent-fill" style="height:4px;background:@@ACCENT@@;border-radius:15px 15px 0 0;font-size:0;line-height:4px;">&nbsp;</td></tr>
<tr><td class="content" style="padding:36px 40px 32px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 32px;"><tr><td width="44" style="width:44px;vertical-align:middle;"><img src="cid:onesa-company-logo" width="44" height="44" alt="" style="display:block;width:44px;height:44px;"></td><td style="padding-left:12px;"><div class="ink" style="font-size:23px;line-height:28px;font-weight:700;letter-spacing:3px;color:#20382d;">ONESA</div><div class="muted" style="margin-top:3px;font-size:11px;line-height:17px;letter-spacing:.6px;color:#566952;">@@BRAND@@</div></td></tr></table>
<h1 class="heading ink" style="margin:0 0 18px;font-size:32px;line-height:39px;font-weight:700;letter-spacing:-.7px;color:#20382d;overflow-wrap:anywhere;">@@HEADING@@</h1>
<div class="copy" style="font-size:16px;line-height:27px;color:#566952;overflow-wrap:anywhere;word-break:break-word;">@@CONTENT@@</div>
@@ACTION@@
@@FALLBACK@@
</td></tr>
<tr><td class="footer rule" style="padding:24px 40px 28px;border-top:1px solid #dfe5dc;border-radius:0 0 15px 15px;">
<p class="muted" style="margin:0 0 14px;font-size:11px;line-height:18px;color:#566952;">@@FOOTER@@</p>
<p class="muted" style="margin:0 0 8px;font-size:12px;line-height:20px;color:#566952;"><strong>Onesa UG (haftungsbeschränkt)</strong><br>Steinhofweg 47, 69123 Heidelberg, Germany<br>Geschäftsführer / Managing Director: Andrew Gotora<br>Amtsgericht Mannheim, HRB 757830</p>
<p class="muted" style="margin:0;font-size:12px;line-height:20px;color:#566952;"><a class="url" href="mailto:info@onesa.eu" style="color:#235f43;text-decoration:underline;">info@onesa.eu</a> &nbsp;&middot;&nbsp; +49 151 474 16152</p>
</td></tr></table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table></body></html>`;
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const paragraphs = (value: string) => value.split(/\n\s*\n/).filter(p => p.trim()).map(p => `<p style="margin:0 0 18px;">${escapeHtml(p).replaceAll("\n", "<br>")}</p>`).join("");
function webOrigin(value: string): string | undefined {
  try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password ? u.origin : undefined; }
  catch { return undefined; }
}
function button(href: string | undefined, label: string, accent: string) {
  return href ? `<table role="presentation" style="margin:28px 0 8px;"><tr><td class="button" bgcolor="${accent}" style="background:${accent};border-radius:8px;mso-padding-alt:16px 24px;"><a class="button-label" href="${escapeHtml(href)}" style="display:inline-block;padding:16px 24px;color:#ffffff;font-size:15px;font-weight:bold;text-decoration:none;line-height:20px;border:1px solid ${accent};border-radius:8px;">${escapeHtml(label)} &nbsp;&#8594;</a></td></tr></table>` : "";
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
    BRAND: "Smart Farmer", MONOGRAM: "SF", ACCENT: "#235f43", SOFT: "#e8f1e5", LABEL: "SMART FARMER",
    HEADING: escapeHtml(content.title),
    CONTENT: code ? `<div class="panel ink" style="padding:24px 16px;margin:4px 0 24px;background:#e8f1e5;border:1px solid #dfe5dc;border-radius:10px;text-align:center;font-family:Consolas,monospace;font-size:36px;line-height:44px;font-weight:bold;letter-spacing:6px;color:#20382d;">${escapeHtml(content.body.trim())}</div><p class="muted" style="font-size:13px;text-align:center;margin:0;">10 min</p>` : paragraphs(content.body),
    ACTION: button(origin, actionLabel, "#235f43"), FALLBACK: "",
    NOTE: "Smart Farmer &nbsp;&middot;&nbsp; onesa.eu", FOOTER: "farmer.onesa.eu",
  });
}
