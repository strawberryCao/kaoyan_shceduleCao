export interface SafeHtmlArtifactSpec {
  title?: string;
  html?: string;
  css?: string;
  js?: string;
  theme?: 'light' | 'dark';
  width?: number;
  height?: number;
}

export const safeHtmlArtifactFileName = (value: string): string => `${String(value || 'AI 交互笔记')
  .normalize('NFKC')
  .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .replace(/^[.\s]+|[.\s]+$/g, '')
  .slice(0, 80) || 'AI 交互笔记'}.html`;

const sanitizeHtml = (html: string): string => html
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  .replace(/<\/?(?:iframe|object|embed|link|meta|base|form)\b[^>]*>/gi, '')
  .replace(/\son[a-z]+\s*=\s*(["'])[\s\S]*?\1/gi, '')
  .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
  .replace(/\s(?:href|src|srcset|xlink:href|action|formaction|poster|ping)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');

const escapeClosingTag = (value: string, tag: 'script' | 'style'): string => value.replace(
  new RegExp(`</${tag}`, 'gi'),
  `<\\/${tag}`,
);

export const buildSafeHtmlArtifact = (input: SafeHtmlArtifactSpec): string => {
  const title = String(input.title || 'AI 交互笔记').replace(/[<>&"']/g, '').trim().slice(0, 80) || 'AI 交互笔记';
  const html = sanitizeHtml(String(input.html || '').slice(0, 40_000));
  const css = escapeClosingTag(String(input.css || '').slice(0, 30_000), 'style');
  const js = escapeClosingTag(String(input.js || '').slice(0, 30_000), 'script');
  const dark = input.theme === 'dark';
  const width = Math.max(240, Math.min(720, Math.round(Number(input.width) || 520)));
  const height = Math.max(150, Math.min(620, Math.round(Number(input.height) || 360)));
  return `<!doctype html>
<html lang="zh-CN" data-kaoyan-artifact-width="${width}" data-kaoyan-artifact-height="${height}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; worker-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'" />
<title>${title}</title>
<style>
:root{color-scheme:${dark ? 'dark' : 'light'};font-family:"Microsoft YaHei",system-ui,sans-serif}
*{box-sizing:border-box}
html,body{width:100%;min-height:100%;margin:0;overflow:auto;background:${dark ? 'transparent' : '#f8f6f1'};color:${dark ? '#f7ead6' : '#25231f'}
body{padding:clamp(12px,3vw,28px)}
button,input,textarea,select{font:inherit}
${css}
html>body{width:100%;max-width:${width}px;min-height:min(${height}px,100dvh);margin-inline:auto}
</style>
</head>
<body>
${html}
<script>
"use strict";
try {
${js}
} catch (error) {
  document.body.insertAdjacentHTML('beforeend', '<pre style="white-space:pre-wrap;color:#9b2727;padding:10px;font:12px/1.5 monospace">交互脚本运行失败：' + String(error && error.message || error) + '</pre>');
}
<\/script>
</body>
</html>`;
};

export const hashSafeHtmlArtifact = async (source: string): Promise<string> => {
  if (!globalThis.crypto?.subtle) return '';
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};
