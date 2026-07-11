import { useMemo } from 'react';
import type { WidgetLayout } from './types';

interface AiCodeModuleSpec {
  html?: string;
  css?: string;
  js?: string;
}

const EMPTY_SPEC: Required<AiCodeModuleSpec> = {
  html: '<div class="empty">这个 AI 模块没有可显示的内容。</div>',
  css: '.empty{padding:16px;color:#f2dec0;font:600 14px/1.6 system-ui,sans-serif}',
  js: '',
};

const parseSpec = (content?: string): Required<AiCodeModuleSpec> => {
  if (!content) {
    return EMPTY_SPEC;
  }
  try {
    const parsed = JSON.parse(content) as AiCodeModuleSpec;
    return {
      html: String(parsed.html || EMPTY_SPEC.html).slice(0, 40000),
      css: String(parsed.css || '').slice(0, 30000),
      js: String(parsed.js || '').slice(0, 30000),
    };
  } catch {
    return {
      ...EMPTY_SPEC,
      html: `<div class="empty">${String(content).replace(/[<&>]/g, '')}</div>`,
    };
  }
};

const sanitizeHtml = (html: string) => html
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  .replace(/<\/?(?:iframe|object|embed|link|meta|base|form)\b[^>]*>/gi, '')
  .replace(/\son[a-z]+\s*=\s*(["'])[\s\S]*?\1/gi, '')
  .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '');

const escapeClosingTag = (value: string, tag: 'script' | 'style') => value.replace(
  new RegExp(`</${tag}`, 'gi'),
  `<\\/${tag}`,
);

const buildSrcDoc = (spec: Required<AiCodeModuleSpec>) => {
  const html = sanitizeHtml(spec.html);
  const css = escapeClosingTag(spec.css, 'style');
  const js = escapeClosingTag(spec.js, 'script');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'" />
<style>
:root{color-scheme:dark;font-family:"Microsoft YaHei",system-ui,sans-serif}
*{box-sizing:border-box}
html,body{width:100%;height:100%;margin:0;overflow:auto;background:transparent;color:#f7ead6}
button,input,textarea,select{font:inherit}
${css}
</style>
</head>
<body>
${html}
<script>
"use strict";
try {
${js}
} catch (error) {
  document.body.insertAdjacentHTML('beforeend', '<pre style="white-space:pre-wrap;color:#ffb8b8;padding:10px;font:12px/1.5 monospace">模块脚本运行失败：' + String(error && error.message || error) + '</pre>');
}
<\/script>
</body>
</html>`;
};

export function AiCodeWidget({ widget }: { widget: WidgetLayout }) {
  const srcDoc = useMemo(() => buildSrcDoc(parseSpec(widget.content)), [widget.content]);
  return (
    <div className="study-widget-content ai-code-widget">
      <iframe
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        title={`${widget.title} AI 代码模块`}
      />
    </div>
  );
}
